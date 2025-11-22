import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "./models/User.js";
import bcrypt from "bcryptjs";

dotenv.config();

const staff = [
  { name: "Admin", username: "admin", password: "1234", role: "admin", pin: "0000" },
  { name: "Kassir Dilshod", username: "dilshod", password: "pass123", role: "kassir", pin: "1111" },
  { name: "Ofitsiant Sardor", username: "sardor", password: "pass123", role: "ofitsiant", pin: "2222" },
  { name: "Oshpaz Lola", username: "lola", password: "pass123", role: "oshpaz", pin: "3333" },
];

async function seedStaff() {
  await mongoose.connect(process.env.MONGO_URI);
  for (const person of staff) {
    const exists = await User.findOne({ username: person.username });
    if (exists) continue;
    const passwordHash = await bcrypt.hash(person.password, 10);
    const pinHash = await bcrypt.hash(person.pin, 10);
    await User.create({ ...person, passwordHash, pinHash });
  }
  console.log("Staff seed tugadi");
  process.exit(0);
}

seedStaff();
