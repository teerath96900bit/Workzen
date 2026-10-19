const API_URL = "http://localhost:5000/api";

// ==========================================
// 1. AUTHENTICATION LOGIC (For index.html)
// ==========================================
if (document.getElementById("register-form")) {
    if (localStorage.getItem("token")) window.location.href = "dashboard.html";

    const authForm = document.getElementById("register-form");
    const nameInput = document.getElementById("name");
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    const messageEl = document.getElementById("message");
    const toggleLink = document.getElementById("show-login");
    const formTitle = document.querySelector(".auth-box h2");
    const submitBtn = authForm.querySelector("button");

    let isLoginMode = false;

    function switchMode(e) {
        if (e) e.preventDefault();
        isLoginMode = !isLoginMode;
        
        if (isLoginMode) {
            formTitle.textContent = "Login to Workzen";
            nameInput.style.display = "none";
            nameInput.removeAttribute("required");
            submitBtn.textContent = "Login";
            toggleLink.innerHTML = "Don't have an account? <a href='#'>Register</a>";
        } else {
            formTitle.textContent = "Create Your Account";
            nameInput.style.display = "block";
            nameInput.setAttribute("required", "true");
            submitBtn.textContent = "Create Account";
            toggleLink.innerHTML = "Already have an account? <a href='#'>Login</a>";
        }
        messageEl.textContent = "";
    }

    toggleLink.addEventListener("click", switchMode);

    authForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        submitBtn.textContent = "Processing...";
        
        const endpoint = isLoginMode ? "/login" : "/register";
        const payload = { email: emailInput.value, password: passwordInput.value };
        if (!isLoginMode) payload.name = nameInput.value;

        try {
            const response = await fetch(API_URL + endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const data = await response.json();

            if (response.ok) {
                messageEl.style.color = "green";
                if (isLoginMode) {
                    messageEl.textContent = "Login successful! Redirecting...";
                    localStorage.setItem("token", data.token);
                    localStorage.setItem("user", JSON.stringify(data.user));
                    setTimeout(() => window.location.href = "dashboard.html", 1000);
                } else {
                    messageEl.textContent = "Registration successful! Switching to login...";
                    setTimeout(() => {
                        switchMode();
                        emailInput.value = payload.email;
                        passwordInput.value = "";
                        messageEl.style.color = "#4f46e5";
                        messageEl.textContent = "Please login with your new account.";
                    }, 1500);
                }
            } else {
                messageEl.style.color = "red";
                messageEl.textContent = data.message || "Something went wrong!";
            }
        } catch (error) {
            messageEl.style.color = "red";
            messageEl.textContent = "Server error. Is your backend running?";
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = isLoginMode ? "Login" : "Create Account";
        }
    });
}

// ==========================================
// 2. DASHBOARD & KANBAN LOGIC (For dashboard.html)
// ==========================================
if (document.getElementById("project-list")) {
    const token = localStorage.getItem("token");
    let currentProjectId = null; 
    let currentTaskId = null; // Jo task open hai uski ID track karne ke liye
    
    if (!token) window.location.href = "index.html";

    const user = JSON.parse(localStorage.getItem("user") || "{}");
    document.getElementById("user-name").textContent = `Welcome, ${user.name || 'User'}`;

    document.getElementById("logout-btn").addEventListener("click", () => {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.href = "index.html";
    });

    async function fetchProjects() {
        try {
            const response = await fetch(`${API_URL}/projects`, {
                headers: { "Authorization": `Bearer ${token}` }
            });
            const projects = await response.json();
            const projectList = document.getElementById("project-list");
            projectList.innerHTML = ""; 

            projects.forEach(project => {
                const li = document.createElement("li");
                li.textContent = project.name;
                li.addEventListener("click", () => selectProject(project, li));
                projectList.appendChild(li);
            });
        } catch (error) {
            console.error("Error fetching projects:", error);
        }
    }

    document.getElementById("new-project-btn").addEventListener("click", async () => {
        const projectName = prompt("Enter new project name:");
        if (!projectName || !projectName.trim()) return;

        try {
            const response = await fetch(`${API_URL}/projects`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                body: JSON.stringify({ name: projectName })
            });
            if (response.ok) fetchProjects(); 
        } catch (error) { console.error("Error creating project:", error); }
    });

    
async function loadTeamMembers() {
    const list = document.getElementById("team-members-list");
    const message = document.getElementById("member-message");

    list.replaceChildren();

    try {
        const response = await fetch(
            `${API_URL}/projects/${currentProjectId}/members`,
            {
                headers: { Authorization: `Bearer ${token}` }
            }
        );

        const members = await response.json();

        if (!response.ok) {
            throw new Error(members.message || "Could not load team members.");
        }

        if (members.length === 0) {
            list.textContent = "No team members yet.";
            return;
        }

        members.forEach(member => {
            const li = document.createElement("li");
            li.textContent =
                `${member.name} (${member.email}) — ${member.role || "member"}`;
            list.appendChild(li);
        });
    } catch (error) {
        message.textContent = error.message;
    }
}

document.getElementById("add-member-form").addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!currentProjectId) return;

    const emailInput = document.getElementById("member-email");
    const message = document.getElementById("member-message");
    const button = document.getElementById("add-member-btn");

    button.disabled = true;
    message.textContent = "Adding member...";

    try {
        const response = await fetch(
            `${API_URL}/projects/${currentProjectId}/members`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ email: emailInput.value.trim() })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "Could not add member.");
        }

        message.textContent = data.message || "Member added successfully.";
        emailInput.value = "";

        await loadTeamMembers();
    } catch (error) {
        message.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

    async function fetchTasks(projectId) {
        try {
            const response = await fetch(`${API_URL}/projects/${projectId}/tasks`, {
                headers: { "Authorization": `Bearer ${token}` }
            });
            const tasks = await response.json();
            
            document.querySelector("#col-todo .task-list").innerHTML = "";
            document.querySelector("#col-in_progress .task-list").innerHTML = "";
            document.querySelector("#col-done .task-list").innerHTML = "";

            tasks.forEach(task => {
                const taskCard = document.createElement("div");
                taskCard.className = "task-card";
                taskCard.draggable = true;
                taskCard.dataset.id = task.id;
                
                // Card mein Assignee ka naam bhi dikhayenge
                const assigneeText = task.assignee_name ? `<br><small style="color:#4f46e5;">Assigned to: ${task.assignee_name}</small>` : '';
                
                taskCard.innerHTML = `
                    <h4>${task.title}</h4>
                    <p>${task.description || ""}${assigneeText}</p>
                `;
                
                taskCard.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", task.id));
                
                // Task par click karne se Modal open hoga
                taskCard.addEventListener("click", () => openTaskModal(task));

                document.querySelector(`#col-${task.status} .task-list`).appendChild(taskCard);
            });
        } catch (error) { console.error("Error fetching tasks:", error); }
    }

    document.getElementById("new-task-btn").addEventListener("click", async () => {
        if (!currentProjectId) return;
        const title = prompt("Task Title:");
        if (!title || !title.trim()) return;
        const description = prompt("Task Description (optional):");

        try {
            const response = await fetch(`${API_URL}/projects/${currentProjectId}/tasks`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                body: JSON.stringify({ title, description, status: "todo" })
            });
            if (response.ok) fetchTasks(currentProjectId);
        } catch (error) { console.error("Error creating task:", error); }
    });

    // Drag & Drop
    document.querySelectorAll(".kanban-column").forEach(column => {
        column.addEventListener("dragover", e => e.preventDefault());
        column.addEventListener("drop", async e => {
            e.preventDefault();
            const taskId = e.dataTransfer.getData("text/plain");
            const newStatus = column.id.replace("col-", ""); 
            
            const taskCard = document.querySelector(`.task-card[data-id='${taskId}']`);
            if (taskCard) column.querySelector(".task-list").appendChild(taskCard);

            try {
                await fetch(`${API_URL}/tasks/${taskId}/status`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                    body: JSON.stringify({ status: newStatus })
                });
            } catch (error) {
                console.error("Error updating status:", error);
                fetchTasks(currentProjectId); 
            }
        });
    });

    // ==========================================
    // 3. TASK MODAL (POPUP) & COMMENTS LOGIC
    // ==========================================
    const taskModal = document.getElementById("task-modal");
    const closeModal = document.getElementById("close-modal");
    const assigneeSelect = document.getElementById("assignee-select");
    const commentsList = document.getElementById("comments-list");
    const newCommentInput = document.getElementById("new-comment");
    const postCommentBtn = document.getElementById("post-comment-btn");

    // Close Modal
    closeModal.addEventListener("click", () => taskModal.style.display = "none");
    window.addEventListener("click", (e) => { if (e.target === taskModal) taskModal.style.display = "none"; });

    // Open Modal Function
    async function openTaskModal(task) {
        currentTaskId = task.id;
        document.getElementById("modal-task-title").textContent = task.title;
        document.getElementById("modal-task-desc").textContent = task.description || "No description provided.";
        taskModal.style.display = "flex";

        // Dropdown members load karein
        await loadProjectMembers(task.assigned_to);
        // Comments load karein
        await loadComments();
    }

    // Load Members for Dropdown
    async function loadProjectMembers(currentAssigneeId) {
        try {
            const response = await fetch(`${API_URL}/projects/${currentProjectId}/members`, {
                headers: { "Authorization": `Bearer ${token}` }
            });
            const members = await response.json();
            
            assigneeSelect.innerHTML = '<option value="">Unassigned</option>';
            members.forEach(m => {
                const opt = document.createElement("option");
                opt.value = m.id;
                opt.textContent = m.name;
                if (m.id === currentAssigneeId) opt.selected = true;
                assigneeSelect.appendChild(opt);
            });
        } catch (error) { console.error("Error loading members:", error); }
    }

    // Assign Task API call on dropdown change
    assigneeSelect.addEventListener("change", async (e) => {
        if (!currentTaskId) return;
        try {
            await fetch(`${API_URL}/tasks/${currentTaskId}/assign`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                body: JSON.stringify({ assigned_to: e.target.value })
            });
            fetchTasks(currentProjectId); // Board update karein taki assignee ka naam card pe aaye
        } catch (error) { console.error("Error assigning task:", error); }
    });

    // Load Comments
    async function loadComments() {
        try {
            const response = await fetch(`${API_URL}/tasks/${currentTaskId}/comments`, {
                headers: { "Authorization": `Bearer ${token}` }
            });
            const comments = await response.json();
            
            commentsList.innerHTML = "";
            comments.forEach(c => {
                const div = document.createElement("div");
                div.className = "comment-item";
                div.innerHTML = `<strong>${c.user_name}:</strong> ${c.comment}`;
                commentsList.appendChild(div);
            });
        } catch (error) { console.error("Error loading comments:", error); }
    }

    // Post Comment
    postCommentBtn.addEventListener("click", async () => {
        const text = newCommentInput.value.trim();
        if (!text || !currentTaskId) return;

        try {
            const response = await fetch(`${API_URL}/tasks/${currentTaskId}/comments`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                body: JSON.stringify({ comment: text })
            });
            if (response.ok) {
                newCommentInput.value = "";
                loadComments(); // Comments list refresh karein
            }
        } catch (error) { console.error("Error posting comment:", error); }
    });

    
function selectProject(project, liElement) {
    currentProjectId = project.id;

    document.querySelectorAll("#project-list li")
        .forEach(el => el.classList.remove("active"));

    liElement.classList.add("active");

    document.getElementById("current-project-title").textContent = project.name;
    document.getElementById("new-task-btn").style.display = "block";
    document.getElementById("kanban-board").style.display = "flex";

    const teamSection = document.getElementById("team-members-section");
    if (teamSection) {
        teamSection.style.display = "block";
        loadTeamMembers();
    }

    fetchTasks(project.id);
}


    fetchProjects();
}