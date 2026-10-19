
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./database");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

require("dotenv").config({
    path: path.join(__dirname, ".env")
});

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error("JWT_SECRET missing. Create backend/.env first.");
}

const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());

/* =========================
   FILE UPLOAD SETUP
========================= */

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

app.use("/uploads", express.static(uploadDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const safeName = path.basename(file.originalname)
            .replace(/[^a-zA-Z0-9._-]/g, "_");

        cb(null, `${Date.now()}-${safeName}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

/* =========================
   AUTHENTICATION
========================= */

function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
        ? authHeader.split(" ")[1]
        : null;

    if (!token) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (error) {
        return res.status(401).json({
            message: "Invalid or expired token."
        });
    }
}

function isProjectMember(projectId, userId) {
    return Boolean(
        db.prepare(`
            SELECT 1 FROM project_members
            WHERE project_id = ? AND user_id = ?
        `).get(projectId, userId)
    );
}

function getTask(taskId) {
    return db.prepare(`
        SELECT id, project_id, title, assigned_to
        FROM tasks
        WHERE id = ?
    `).get(taskId);
}

function canAccessTask(taskId, userId) {
    const task = getTask(taskId);

    if (!task) {
        return { task: null, allowed: false };
    }

    return {
        task,
        allowed: isProjectMember(task.project_id, userId)
    };
}

/* =========================
   SOCKET.IO AUTHENTICATION
========================= */

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
        return next(new Error("Authentication required"));
    }

    try {
        socket.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (error) {
        next(new Error("Invalid or expired token"));
    }
});

io.on("connection", (socket) => {
    const userId = Number(socket.user.id);

    socket.join(`user:${userId}`);

    // Join only projects the authenticated user belongs to.
    const projects = db.prepare(`
        SELECT project_id
        FROM project_members
        WHERE user_id = ?
    `).all(userId);

    projects.forEach((project) => {
        socket.join(`project:${project.project_id}`);
    });
});

/* =========================
   TEST ROUTE
========================= */

app.get("/", (req, res) => {
    res.send("Workzen Backend is Running!");
});

/* =========================
   REGISTER
========================= */

app.post("/api/register", (req, res) => {
    const { name, email, password } = req.body;

    if (
        typeof name !== "string" ||
        typeof email !== "string" ||
        typeof password !== "string" ||
        !name.trim() ||
        !email.trim() ||
        !password
    ) {
        return res.status(400).json({
            message: "Name, email and password are required."
        });
    }

    if (password.length < 8) {
        return res.status(400).json({
            message: "Password must be at least 8 characters."
        });
    }

    try {
        const cleanName = name.trim();
        const cleanEmail = email.trim().toLowerCase();

        const existing = db.prepare(
            "SELECT id FROM users WHERE email = ?"
        ).get(cleanEmail);

        if (existing) {
            return res.status(409).json({
                message: "Email already registered."
            });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);

        const result = db.prepare(`
            INSERT INTO users (name, email, password)
            VALUES (?, ?, ?)
        `).run(cleanName, cleanEmail, hashedPassword);

        res.status(201).json({
            message: "Registration successful!",
            user: {
                id: result.lastInsertRowid,
                name: cleanName,
                email: cleanEmail
            }
        });
    } catch (error) {
        console.error("Register error:", error);
        res.status(500).json({
            message: "Registration failed."
        });
    }
});

/* =========================
   LOGIN
========================= */

app.post("/api/login", (req, res) => {
    const { email, password } = req.body;

    if (
        typeof email !== "string" ||
        typeof password !== "string" ||
        !email.trim() ||
        !password
    ) {
        return res.status(400).json({
            message: "Email and password are required."
        });
    }

    try {
        const user = db.prepare(
            "SELECT * FROM users WHERE email = ?"
        ).get(email.trim().toLowerCase());

        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({
                message: "Invalid email or password."
            });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: "1d" }
        );

        res.json({
            message: "Login successful!",
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email
            }
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({
            message: "Login failed."
        });
    }
});

/* =========================
   CREATE PROJECT
========================= */

app.post("/api/projects", authenticateToken, (req, res) => {
    const { name, description = "" } = req.body;

    if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
            message: "Project name is required."
        });
    }

    try {
        const createProject = db.transaction(() => {
            const result = db.prepare(`
                INSERT INTO projects (name, description, owner_id)
                VALUES (?, ?, ?)
            `).run(name.trim(), description, req.user.id);

            db.prepare(`
                INSERT INTO project_members (project_id, user_id, role)
                VALUES (?, ?, 'owner')
            `).run(result.lastInsertRowid, req.user.id);

            return result.lastInsertRowid;
        });

        const projectId = createProject();

        res.status(201).json({
            message: "Project created successfully!",
            project: {
                id: projectId,
                name: name.trim()
            }
        });
    } catch (error) {
        console.error("Create project error:", error);
        res.status(500).json({
            message: "Could not create project."
        });
    }
});

/* =========================
   GET MY PROJECTS
========================= */

app.get("/api/projects", authenticateToken, (req, res) => {
    try {
        const projects = db.prepare(`
            SELECT p.*, pm.role
            FROM projects p
            JOIN project_members pm ON pm.project_id = p.id
            WHERE pm.user_id = ?
            ORDER BY p.id DESC
        `).all(req.user.id);

        res.json(projects);
    } catch (error) {
        console.error("Get projects error:", error);
        res.status(500).json({
            message: "Failed to fetch projects."
        });
    }
});

/* =========================
   ADD PROJECT MEMBER
========================= */

app.post(
    "/api/projects/:projectId/members",
    authenticateToken,
    (req, res) => {
        const projectId = Number(req.params.projectId);
        const { email } = req.body;

        if (!Number.isInteger(projectId) || projectId < 1) {
            return res.status(400).json({
                message: "Invalid project ID."
            });
        }

        if (typeof email !== "string" || !email.trim()) {
            return res.status(400).json({
                message: "Member email is required."
            });
        }

        const project = db.prepare(`
            SELECT id FROM projects
            WHERE id = ? AND owner_id = ?
        `).get(projectId, req.user.id);

        if (!project) {
            return res.status(403).json({
                message: "Only the project owner can add members."
            });
        }

        const member = db.prepare(`
            SELECT id, name, email
            FROM users
            WHERE email = ?
        `).get(email.trim().toLowerCase());

        if (!member) {
            return res.status(404).json({
                message: "User not found. They must register first."
            });
        }

        try {
            db.prepare(`
                INSERT INTO project_members (project_id, user_id)
                VALUES (?, ?)
            `).run(projectId, member.id);

            // Let the newly added member join this project's room.
            io.in(`user:${member.id}`).socketsJoin(
                `project:${projectId}`
            );

            io.to(`project:${projectId}`).emit("projectUpdated", {
                projectId
            });

            res.status(201).json({
                message: "Team member added successfully!",
                member
            });
        } catch (error) {
            if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
                return res.status(409).json({
                    message: "User is already a project member."
                });
            }

            console.error("Add member error:", error);
            res.status(500).json({
                message: "Could not add member."
            });
        }
    }
);

/* =========================
   GET PROJECT MEMBERS
========================= */

app.get(
    "/api/projects/:projectId/members",
    authenticateToken,
    (req, res) => {
        const projectId = Number(req.params.projectId);

        if (!isProjectMember(projectId, req.user.id)) {
            return res.status(403).json({
                message: "You are not a member of this project."
            });
        }

        try {
            const members = db.prepare(`
                SELECT u.id, u.name, u.email, pm.role
                FROM project_members pm
                JOIN users u ON pm.user_id = u.id
                WHERE pm.project_id = ?
            `).all(projectId);

            res.json(members);
        } catch (error) {
            console.error("Get members error:", error);
            res.status(500).json({
                message: "Failed to fetch members."
            });
        }
    }
);

/* =========================
   CREATE TASK
========================= */

app.post(
    "/api/projects/:projectId/tasks",
    authenticateToken,
    (req, res) => {
        const projectId = Number(req.params.projectId);
        const {
            title,
            description = "",
            assigned_to,
            status = "todo",
            priority = "medium",
            due_date = null
        } = req.body;

        if (!isProjectMember(projectId, req.user.id)) {
            return res.status(403).json({
                message: "You are not a member of this project."
            });
        }

        if (typeof title !== "string" || !title.trim()) {
            return res.status(400).json({
                message: "Task title is required."
            });
        }

        if (!["todo", "in_progress", "done"].includes(status)) {
            return res.status(400).json({
                message: "Invalid status."
            });
        }

        if (!["low", "medium", "high"].includes(priority)) {
            return res.status(400).json({
                message: "Invalid priority."
            });
        }

        try {
            let assigneeId = null;

            if (assigned_to !== undefined && assigned_to !== null && assigned_to !== "") {
                assigneeId = Number(assigned_to);

                if (
                    !Number.isInteger(assigneeId) ||
                    !isProjectMember(projectId, assigneeId)
                ) {
                    return res.status(400).json({
                        message: "Assignee must be a member of this project."
                    });
                }
            }

            const result = db.prepare(`
                INSERT INTO tasks
                (project_id, title, description, assigned_to, status, priority, due_date)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                projectId,
                title.trim(),
                description,
                assigneeId,
                status,
                priority,
                due_date
            );

            io.to(`project:${projectId}`).emit("taskUpdated", {
                projectId,
                taskId: result.lastInsertRowid,
                action: "created"
            });

            res.status(201).json({
                message: "Task created!",
                taskId: result.lastInsertRowid
            });
        } catch (error) {
            console.error("Create task error:", error);
            res.status(500).json({
                message: "Failed to create task."
            });
        }
    }
);

/* =========================
   GET PROJECT TASKS
========================= */

app.get(
    "/api/projects/:projectId/tasks",
    authenticateToken,
    (req, res) => {
        const projectId = Number(req.params.projectId);

        if (!isProjectMember(projectId, req.user.id)) {
            return res.status(403).json({
                message: "You are not a member of this project."
            });
        }

        try {
            const tasks = db.prepare(`
                SELECT t.*, u.name AS assignee_name
                FROM tasks t
                LEFT JOIN users u ON t.assigned_to = u.id
                WHERE t.project_id = ?
                ORDER BY t.created_at DESC
            `).all(projectId);

            res.json(tasks);
        } catch (error) {
            console.error("Get tasks error:", error);
            res.status(500).json({
                message: "Failed to fetch tasks."
            });
        }
    }
);

/* =========================
   UPDATE TASK STATUS
========================= */

app.patch(
    "/api/tasks/:taskId/status",
    authenticateToken,
    (req, res) => {
        const { status } = req.body;
        const taskId = Number(req.params.taskId);

        if (!["todo", "in_progress", "done"].includes(status)) {
            return res.status(400).json({
                message: "Invalid status."
            });
        }

        const { task, allowed } = canAccessTask(taskId, req.user.id);

        if (!task) {
            return res.status(404).json({
                message: "Task not found."
            });
        }

        if (!allowed) {
            return res.status(403).json({
                message: "You are not a member of this project."
            });
        }

        try {
            db.prepare(`
                UPDATE tasks SET status = ? WHERE id = ?
            `).run(status, taskId);

            io.to(`project:${task.project_id}`).emit("taskUpdated", {
                projectId: task.project_id,
                taskId,
                action: "status"
            });

            res.json({
                message: "Task status updated!"
            });
        } catch (error) {
            console.error("Update status error:", error);
            res.status(500).json({
                message: "Failed to update task."
            });
        }
    }
);

/* =========================
   ASSIGN TASK
========================= */

app.patch(
    "/api/tasks/:taskId/assign",
    authenticateToken,
    (req, res) => {
        const taskId = Number(req.params.taskId);
        const { assigned_to } = req.body;

        const { task, allowed } = canAccessTask(taskId, req.user.id);

        if (!task) {
            return res.status(404).json({
                message: "Task not found."
            });
        }

        if (!allowed) {
            return res.status(403).json({
                message: "You are not a member of this project."
            });
        }

        let assigneeId = null;
if (assigneeId) {
    const message = `You have been assigned task: ${task.title}`;

    db.prepare(`
        INSERT INTO notifications (user_id, message)
        VALUES (?, ?)
    `).run(assigneeId, message);

    io.to(`user:${assigneeId}`).emit("notification", {
        message,
        taskId,
        projectId: task.project_id
    });
}


        try {
            db.prepare(`
                UPDATE tasks SET assigned_to = ? WHERE id = ?
            `).run(assigneeId, taskId);

            io.to(`project:${task.project_id}`).emit("taskUpdated", {
                projectId: task.project_id,
                taskId,
                action: "assigned"
            });

            if (assigneeId) {
                io.to(`user:${assigneeId}`).emit("notification", {
                    message: `You have been assigned task: ${task.title}`,
                    taskId,
                    projectId: task.project_id
                });
            }

            res.json({
                message: "Task assigned successfully!"
            });
        } catch (error) {
            console.error("Assign task error:", error);
            res.status(500).json({
                message: "Failed to assign task."
            });
        }
    }
);

/* =========================
   ADD COMMENT
========================= */

app.post(
    "/api/tasks/:taskId/comments",
    authenticateToken,
    (req, res) => {
        const taskId = Number(req.params.taskId);
        const { comment } = req.body;

        if (typeof comment !== "string" || !comment.trim()) {
            return res.status(400).json({
                message: "Comment cannot be empty."
            });
        }

        const { task, allowed } = canAccessTask(taskId, req.user.id);

        if (!task) {
            return res.status(404).json({
                message: "Task not found."
            });
        }

        if (!allowed) {
            return res.status(403).json({
                message: "You are not a member of this project."
            });
        }

        try {
            const result = db.prepare(`
                INSERT INTO comments (task_id, user_id, comment)
                VALUES (?, ?, ?)
            `).run(taskId, req.user.id, comment.trim());

            io.to(`project:${task.project_id}`).emit("taskUpdated", {
                projectId: task.project_id,
                taskId,
                commentId: result.lastInsertRowid,
                action: "comment"
            });

            res.status(201).json({
                message: "Comment added!"
            });
        } catch (error) {
            console.error("Add comment error:", error);
            res.status(500).json({
                message: "Failed to add comment."
            });
        }
    }
);

/* =========================
   GET COMMENTS
========================= */

app.get(
    "/api/tasks/:taskId/comments",
    authenticateToken,
    (req, res) => {
        const taskId = Number(req.params.taskId);
        const { task, allowed } = canAccessTask(taskId, req.user.id);

        if (!task) {
            return res.status(404).json({
                message: "Task not found."
            });
        }

        if (!allowed) {
            return res.status(403).json({
                message: "You are not a member of this project."
            });
        }

        try {
            const comments = db.prepare(`
                SELECT c.*, u.name AS user_name
                FROM comments c
                JOIN users u ON c.user_id = u.id
                WHERE c.task_id = ?
                ORDER BY c.created_at ASC
            `).all(taskId);

            res.json(comments);
        } catch (error) {
            console.error("Get comments error:", error);
            res.status(500).json({
                message: "Failed to fetch comments."
            });
        }
    }
);

/* =========================
   UPLOAD ATTACHMENT
========================= */

app.post(
    "/api/tasks/:taskId/attachments",
    authenticateToken,
    (req, res, next) => {
        const taskId = Number(req.params.taskId);
        const { task, allowed } = canAccessTask(taskId, req.user.id);

        if (!task) {
            return res.status(404).json({
                message: "Task not found."
            });
        }

        if (!allowed) {
            return res.status(403).json({
                message: "You are not a member of this project."
            });
        }

        req.task = task;
        next();
    },
    upload.single("file"),
    (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                message: "Please select a file."
            });
        }

        try {
            const filePath = `/uploads/${req.file.filename}`;

            db.prepare(`
                INSERT INTO attachments
                (task_id, file_name, file_path, uploaded_by)
                VALUES (?, ?, ?, ?)
            `).run(
                req.params.taskId,
                req.file.originalname,
                filePath,
                req.user.id
            );

            io.to(`project:${req.task.project_id}`).emit("taskUpdated", {
                projectId: req.task.project_id,
                taskId: req.task.id,
                action: "attachment"
            });

            res.status(201).json({
                message: "File uploaded successfully!",
                filePath
            });
        } catch (error) {
            // Remove the uploaded file if its database record fails.
            if (req.file?.path && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }

            console.error("Upload error:", error);
            res.status(500).json({
                message: "Failed to upload file."
            });
        }
    }
);

/* =========================
   GET ATTACHMENTS
========================= */

app.get(
    "/api/tasks/:taskId/attachments",
    authenticateToken,
    (req, res) => {
        const taskId = Number(req.params.taskId);
        const { task, allowed } = canAccessTask(taskId, req.user.id);

        if (!task) {
            return res.status(404).json({
                message: "Task not found."
            });
        }

        if (!allowed) {
            return res.status(403).json({
                message: "You are not a member of this project."
            });
        }

        try {
            const attachments = db.prepare(`
                SELECT *
                FROM attachments
                WHERE task_id = ?
                ORDER BY created_at DESC
            `).all(taskId);

            res.json(attachments);
        } catch (error) {
            console.error("Get attachments error:", error);
            res.status(500).json({
                message: "Failed to fetch attachments."
            });
        }
    }
);


/* ==============================
   WORKZEN NOTIFICATIONS API
============================== */

// Get notifications for the logged-in user
app.get("/api/notifications", authenticateToken, (req, res) => {
    try {
        const userId = req.user.id;

        const notifications = db.prepare(`
            SELECT id, message, is_read, created_at
            FROM notifications
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        `).all(userId);

        res.json(notifications);
    } catch (error) {
        console.error("Get notifications error:", error);
        res.status(500).json({ message: "Failed to load notifications" });
    }
});

// Mark one notification as read
app.patch("/api/notifications/:id/read", authenticateToken, (req, res) => {
    try {
        const notificationId = Number(req.params.id);
        const userId = req.user.id;

        if (!Number.isInteger(notificationId) || notificationId < 1) {
            return res.status(400).json({
                message: "Invalid notification ID"
            });
        }

        const result = db.prepare(`
            UPDATE notifications
            SET is_read = 1
            WHERE id = ? AND user_id = ?
        `).run(notificationId, userId);

        if (result.changes === 0) {
            return res.status(404).json({
                message: "Notification not found"
            });
        }

        res.json({ message: "Notification marked as read" });
    } catch (error) {
        console.error("Mark notification error:", error);
        res.status(500).json({ message: "Failed to update notification" });
    }
});

// Mark all notifications as read
app.patch("/api/notifications/read-all", authenticateToken, (req, res) => {
    try {
        db.prepare(`
            UPDATE notifications
            SET is_read = 1
            WHERE user_id = ?
        `).run(req.user.id);

        res.json({ message: "All notifications marked as read" });
    } catch (error) {
        console.error("Mark all notifications error:", error);
        res.status(500).json({ message: "Failed to update notifications" });
    }
});


/* =========================
   START SERVER
========================= */

server.listen(PORT, () => {
    console.log(`Workzen server running at http://localhost:${PORT}`);
});
