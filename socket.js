// src/backend/socket.js
import { randomUUID } from "crypto";

const agentChannels = new Map(); // channel -> { socket, lastSeen, meta }
const pendingJobs = new Map(); // jobId -> { resolve, reject, timeout, channel }
let ioInstance = null;

const toRoomKey = (value) => {
  if (!value) return "default";
  try {
    return value.toString();
  } catch (_err) {
    return "default";
  }
};

const settlePendingJob = (jobId, payload, isError = false) => {
  const entry = pendingJobs.get(jobId);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pendingJobs.delete(jobId);

  if (isError) {
    const error = payload instanceof Error ? payload : new Error(payload || "Agent xatosi");
    entry.reject(error);
  } else {
    entry.resolve(payload);
  }
};

const unregisterAgentBySocket = (socketId) => {
  for (const [channel, agent] of agentChannels.entries()) {
    if (agent.socket.id === socketId) {
      agentChannels.delete(channel);
      for (const [jobId, entry] of pendingJobs.entries()) {
        if (entry.channel === channel) {
          settlePendingJob(jobId, new Error("Print agent aloqasi uzildi"), true);
        }
      }
      break;
    }
  }
};

export const hasActivePrintAgent = (channel = "default") => agentChannels.has(toRoomKey(channel));

export const dispatchPrintJob = async ({ restaurantId = "default", job, timeoutMs = 10000 }) => {
  if (!job) {
    throw new Error("Job payload majburiy");
  }

  const channelKey = toRoomKey(restaurantId);
  const agentEntry = agentChannels.get(channelKey);
  if (!agentEntry) {
    return {
      success: false,
      message: "Lokal print agent topilmadi",
    };
  }

  if (!ioInstance) {
    throw new Error("Socket.io hali initsializatsiya qilinmagan");
  }

  const jobId = job?.id || randomUUID();
  const payload = {
    ...job,
    id: jobId,
    requestedAt: new Date().toISOString(),
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      settlePendingJob(jobId, new Error("Lokal agent javob bermadi"), true);
    }, timeoutMs);

    pendingJobs.set(jobId, {
      channel: channelKey,
      timeout,
      resolve: (result = {}) => {
        resolve({
          success: result.success !== false,
          message: result.message || "Agent job bajarildi",
          jobId,
          data: result.data,
        });
      },
      reject,
    });

    agentEntry.socket.emit("print-agent:job", {
      jobId,
      job: payload,
      timeoutMs,
    });
  });

};


export const initSocket = (io) => {
  ioInstance = io;

  io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    socket.on("join-restaurant", (restaurantId) => {
      socket.join(toRoomKey(restaurantId));
    });

    socket.on("print-agent:register", ({ channel = "default", meta = {} } = {}) => {
      const channelKey = toRoomKey(channel);
      const previous = agentChannels.get(channelKey);
      if (previous && previous.socket.id !== socket.id) {
        previous.socket.leave(channelKey);
        previous.socket.emit("print-agent:status", { status: "replaced", channel: channelKey });
      }

      agentChannels.set(channelKey, {
        socket,
        lastSeen: Date.now(),
        meta,
      });
      socket.join(channelKey);
      console.log(`Print agent registered on channel: ${channelKey}`);
      socket.emit("print-agent:status", { status: "registered", channel: channelKey });
    });

    socket.on("print-agent:heartbeat", ({ channel = "default" } = {}) => {
      const channelKey = toRoomKey(channel);
      const agent = agentChannels.get(channelKey);
      if (agent && agent.socket.id === socket.id) {
        agent.lastSeen = Date.now();
      }
    });

    socket.on("print-agent:job:result", ({ jobId, success, message, data }) => {
      if (!jobId) return;
      if (success === false) {
        settlePendingJob(jobId, new Error(message || "Agent xatosi"), true);
        return;
      }

      settlePendingJob(jobId, {
        success: true,
        message: message || "Agentdan ijobiy javob",
        data,
      });
    });

    socket.on("order:created", (order) => {
      io.to(toRoomKey(order?.restaurant || order?.restaurantId)).emit("order:new", order);
    });

    socket.on("order:updated", (order) => {
      io.to(toRoomKey(order?.restaurant || order?.restaurantId)).emit("order:updated", order);
    });

    socket.on("disconnect", () => {
      unregisterAgentBySocket(socket.id);
      console.log("Socket disconnected:", socket.id);
    });
  });
};