// src/backend/controllers/authController.js
import User from "../models/User.js";
import Restaurant from "../models/Restaurant.js";
import Settings from "../models/Settings.js";
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

const sanitizeUsernameInput = (value = "") => value.trim().toLowerCase().replace(/\s+/g, "");

const slugify = (value = "") => {
  return value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || `rest-${Date.now()}`;
};

const ensureUniqueRestaurantSlug = async (base) => {
  const normalizedBase = slugify(base);
  let candidate = normalizedBase;
  let counter = 2;
  while (await Restaurant.exists({ slug: candidate })) {
    candidate = `${normalizedBase}-${counter}`;
    counter += 1;
  }
  return candidate;
};

// ============================
// REGISTER USER
// ============================
export const register = async (req, res) => {
  try {
    const {
      name,
      username,
      password,
      role,
      pinCode,
      restaurantId,
      status,
      isSystemAdmin: requestedSystemAdmin,
      createRestaurant,
      restaurantName,
      restaurantSlug,
      restaurantSettings,
    } = req.body;

    let actor = req.user;
    if (!actor) {
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        const token = header.split(" ")[1];
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          actor = await User.findById(decoded.id).select("-passwordHash");
          if (actor && actor.status === "disabled") {
            actor = null;
          }
        } catch (error) {
          actor = null;
        }
      }
    }

    if (!name) {
      return res.status(400).json({ message: "Ism majburiy" });
    }

    if (!pinCode) {
      return res.status(400).json({ message: "PIN talab qilinadi" });
    }

    let targetRestaurantId = restaurantId || null;
    let allowSystemAdminCreation = false;
    let createdRestaurant = null;
    let createdSettingsDoc = null;

    if (!actor) {
      const existingUser = await User.exists({});
      if (existingUser) {
        return res.status(403).json({ message: "Not authorized" });
      }
      allowSystemAdminCreation = true;
    } else if (!actor.isSystemAdmin) {
      if (requestedSystemAdmin) {
        return res.status(403).json({ message: "System admin yaratish uchun ruxsat yo'q" });
      }
      if (actor.role !== "admin") {
        return res.status(403).json({ message: "Faqat admin xodim qo'shishi mumkin" });
      }
      if (!actor.restaurant) {
        return res.status(400).json({ message: "Restoran konteksti mavjud emas" });
      }
      if (targetRestaurantId && actor.restaurant.toString() !== targetRestaurantId.toString()) {
        return res.status(403).json({ message: "Boshqa restoran uchun xodim qo'shish mumkin emas" });
      }
      targetRestaurantId = actor.restaurant.toString();
    }

    let willBeSystemAdmin = false;
    if (actor?.isSystemAdmin) {
      willBeSystemAdmin = Boolean(requestedSystemAdmin);
    } else if (allowSystemAdminCreation) {
      if (typeof requestedSystemAdmin === "undefined") {
        willBeSystemAdmin = true;
      } else {
        willBeSystemAdmin = Boolean(requestedSystemAdmin);
      }
    }

    if (createRestaurant) {
      if (!actor?.isSystemAdmin && !allowSystemAdminCreation) {
        return res.status(403).json({ message: "Restoran yaratish uchun ruxsat yo'q" });
      }

      const baseName = (restaurantName || `${name} Restorani`).trim();
      const uniqueSlug = await ensureUniqueRestaurantSlug(restaurantSlug || baseName);

      createdRestaurant = await Restaurant.create({
        name: baseName,
        slug: uniqueSlug,
      });

      targetRestaurantId = createdRestaurant._id.toString();

      const baseSettings = {
        restaurant: createdRestaurant._id,
        restaurantName: baseName,
      };

      if (restaurantSettings && typeof restaurantSettings === "object") {
        const sanitizedSettings = { ...restaurantSettings };
        delete sanitizedSettings.restaurant;
        Object.assign(baseSettings, sanitizedSettings);
      }

      createdSettingsDoc = await Settings.create(baseSettings);
    }

    if (!willBeSystemAdmin && !targetRestaurantId) {
      return res.status(400).json({ message: "Restoran aniqlanmagan" });
    }

    // Username va parol avtomatik generatsiya
    const normalizedUsername = username
      ? sanitizeUsernameInput(username).replace(/[^a-z0-9._-]/g, "")
      : "";
    if (username && normalizedUsername.length < 3) {
      return res.status(400).json({ message: "Login kamida 3 ta belgidan iborat bo'lishi kerak" });
    }

    const finalUsername = normalizedUsername || await generateUsername(name);
    const finalPassword = password || generatePassword();
    const assignedRole = role || (createRestaurant ? "admin" : "ofitsiant");

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
      role: assignedRole,
      pinHash,
      restaurant: targetRestaurantId,
      status: status || "active",
      isSystemAdmin: willBeSystemAdmin,
    });

    if (createdRestaurant) {
      createdRestaurant.owner = user._id;
      await createdRestaurant.save();
    }

    res.json({
      id: user._id,
      username: user.username,
      role: user.role,
      restaurant: user.restaurant,
      isSystemAdmin: user.isSystemAdmin,
      message: "Xodim muvaffaqiyatli qo'shildi"
    });

  } catch (err) {
    if (createdSettingsDoc?._id) {
      await Settings.deleteOne({ _id: createdSettingsDoc._id }).catch(() => {});
    }
    if (createdRestaurant?._id) {
      await Restaurant.deleteOne({ _id: createdRestaurant._id }).catch(() => {});
    }
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

    const tokenPayload = {
      id: user._id,
      role: user.role,
      restaurantId: user.restaurant ? user.restaurant.toString() : null,
      isSystemAdmin: Boolean(user.isSystemAdmin),
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: "8h" });

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        role: user.role,
        restaurant: user.restaurant,
        isSystemAdmin: Boolean(user.isSystemAdmin),
        status: user.status,
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

    const tokenPayload = {
      id: user._id,
      role: user.role,
      restaurantId: user.restaurant ? user.restaurant.toString() : null,
      isSystemAdmin: Boolean(user.isSystemAdmin),
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: "8h" });

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        username: user.username,
        restaurant: user.restaurant,
        isSystemAdmin: Boolean(user.isSystemAdmin),
        status: user.status,
      },
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const listStaff = async (req, res) => {
  try {
    const filter = {};
    if (!req.isSystemAdmin) {
      if (!req.restaurantId) {
        return res.status(400).json({ message: "Restoran aniqlanmadi" });
      }
      filter.restaurant = req.restaurantId;
    } else if (req.query?.restaurantId) {
      filter.restaurant = req.query.restaurantId;
    }

    const users = await User.find(filter).select("name role username restaurant status isSystemAdmin");
    res.json(
      users.map((user) => ({
        id: user._id,
        name: user.name,
        role: user.role,
        username: user.username,
        restaurant: user.restaurant,
        status: user.status,
        isSystemAdmin: user.isSystemAdmin,
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

    const filter = { _id: id };
    if (!req.isSystemAdmin) {
      if (!req.restaurantId) {
        return res.status(400).json({ message: "Restoran aniqlanmadi" });
      }
      filter.restaurant = req.restaurantId;
    }

    const user = await User.findOne(filter);
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

    const filter = { _id: id };
    if (!req.isSystemAdmin) {
      if (!req.restaurantId) {
        return res.status(400).json({ message: "Restoran aniqlanmadi" });
      }
      filter.restaurant = req.restaurantId;
    }

    const user = await User.findOne(filter);
    if (!user) return res.status(404).json({ message: "Xodim topilmadi" });

    // Prevent deleting yourself or last admin
    if (user.role === "admin") {
      const adminFilter = { role: "admin" };
      if (!req.isSystemAdmin && req.restaurantId) {
        adminFilter.restaurant = req.restaurantId;
      }
      const adminCount = await User.countDocuments(adminFilter);
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
