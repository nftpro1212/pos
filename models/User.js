import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },

    username: { type: String, unique: true, required: true },

    passwordHash: { type: String, required: true },

    role: {
      type: String,
      enum: ["admin", "kassir", "ofitsiant", "oshpaz", "omborchi"],
      default: "kassir",
    },

    pinHash: {
      type: String,
      required: false,
      select: false,
    },
  },
  { timestamps: true }
);

// ===== Parol solishtirish =====
userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.passwordHash);
};

export default mongoose.model("User", userSchema);
