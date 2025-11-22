// src/backend/controllers/authController.js
import User from "../models/User.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// Helper function to generate unique username
const generateUsername = async (name) => {
  // Ismdan username yaratish (kichik harf, bo'shliqsiz)
  let baseUsername = name.toLowerCase().replace(/\s+/g, '');
  let username = baseUsername;
  let counter = 1;
  
  // Agar username mavjud bo'lsa, raqam qo'shish
  while (await User.findOne({ username })) {
    username = `${baseUsername}${counter}`;
    counter++;
  }
  
  return username;
};

// Helper function to generate random password
const generatePassword = () => {
  return Math.random().toString(36).slice(-10);
};

// ============================
// REGISTER USER
// ============================
export const register = async (req, res) => {
  try {
    const { name, username, password, role, pinCode } = req.body;

    if (!pinCode) {
      return res.status(400).json({ message: "PIN talab qilinadi" });
    }

    // Username va parol avtomatik generatsiya
    const finalUsername = username || await generateUsername(name);
    const finalPassword = password || generatePassword();

    const exists = await User.findOne({ username: finalUsername });
    if (exists) return res.status(400).json({ message: "Username already exists" });

    // Parolni hash qilish
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(finalPassword, salt);

    // PINni ham hash qilamiz
    const pinHash = await bcrypt.hash(pinCode, 10);

    const user = await User.create({
      name,
      username: finalUsername,
      passwordHash,
      role: role || "ofitsiant",
      pinHash,
    });

    res.json({
      id: user._id,
      username: user.username,
      role: user.role,
      message: "Xodim muvaffaqiyatli qo'shildi"
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


// ============================
// LOGIN (username + password)
// ============================
export const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        role: user.role,
      },
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


// ============================
// LOGIN by PIN (faqat PIN orqali)
// ============================
export const loginByPin = async (req, res) => {
  try {
    const { userId, pin } = req.body;

    const user = await User.findById(userId).select("+pinHash");
    if (!user) return res.status(400).json({ message: "User not found" });
    if (!user.pinHash) {
      return res.status(400).json({ message: "PIN mavjud emas" });
    }

    // PIN hash bilan solishtiramiz
    const ok = await bcrypt.compare(pin, user.pinHash);
    if (!ok) return res.status(400).json({ message: "PIN noto'g'ri" });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        username: user.username,
      },
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const listStaff = async (_req, res) => {
  try {
    const users = await User.find({}).select("name role username");
    res.json(
      users.map((user) => ({
        id: user._id,
        name: user.name,
        role: user.role,
        username: user.username,
      }))
    );
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============================
// UPDATE STAFF
// ============================
export const updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, pinCode } = req.body;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: "Xodim topilmadi" });

    // Update fields
    if (name) user.name = name;
    if (role) user.role = role;
    
    // Update PIN if provided
    if (pinCode) {
      user.pinHash = await bcrypt.hash(pinCode, 10);
    }

    await user.save();

    res.json({
      id: user._id,
      name: user.name,
      username: user.username,
      role: user.role,
      message: "Xodim muvaffaqiyatli yangilandi"
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ============================
// DELETE STAFF
// ============================
export const deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: "Xodim topilmadi" });

    // Prevent deleting yourself or last admin
    if (user.role === "admin") {
      const adminCount = await User.countDocuments({ role: "admin" });
      if (adminCount <= 1) {
        return res.status(400).json({ message: "Oxirgi adminni o'chirib bo'lmaydi" });
      }
    }

    await User.findByIdAndDelete(id);

    res.json({ message: "Xodim muvaffaqiyatli o'chirildi" });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
