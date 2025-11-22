// src/backend/socket.js
export const initSocket = (io) => {
  io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    // join room for restaurant (optionally by restaurant id)
    socket.on("join-restaurant", (restaurantId) => {
      socket.join(restaurantId || "default");
    });

    socket.on("order:created", (order) => {
      // broadcast to kitchen and other clients
      io.to(order.restaurantId || "default").emit("order:new", order);
    });

    socket.on("order:updated", (order) => {
      io.to(order.restaurantId || "default").emit("order:updated", order);
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected:", socket.id);
    });
  });
};