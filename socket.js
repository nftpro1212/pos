// src/backend/socket.js
import { randomUUID } from "crypto";

const agentChannels = new Map(); // channel -> { socket, lastSeen, meta }
const pendingJobs = new Map(); // jobId -> { resolve, reject, timeout, channel }
let ioInstance = null;

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

export const hasActivePrintAgent = (channel = "default") => agentChannels.has(channel);

export const dispatchPrintJob = async ({ restaurantId = "default", job, timeoutMs = 10000 }) => {
  if (!job) {
    throw new Error("Job payload majburiy");
  }

  const agentEntry = agentChannels.get(restaurantId);
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
      channel: restaurantId,
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
      socket.join(restaurantId || "default");
    });

    socket.on("print-agent:register", ({ channel = "default", meta = {} } = {}) => {
      const previous = agentChannels.get(channel);
      if (previous && previous.socket.id !== socket.id) {
        previous.socket.leave(channel);
        previous.socket.emit("print-agent:status", { status: "replaced", channel });
      }

      agentChannels.set(channel, {
        socket,
        lastSeen: Date.now(),
        meta,
      });
      socket.join(channel);
      console.log(`Print agent registered on channel: ${channel}`);
      socket.emit("print-agent:status", { status: "registered", channel });
    });

    socket.on("print-agent:heartbeat", ({ channel = "default" } = {}) => {
      const agent = agentChannels.get(channel);
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
      io.to(order.restaurantId || "default").emit("order:new", order);
    });

    socket.on("order:updated", (order) => {
      io.to(order.restaurantId || "default").emit("order:updated", order);
    });

    socket.on("disconnect", () => {
      unregisterAgentBySocket(socket.id);
      console.log("Socket disconnected:", socket.id);
    });
  });
};