/**
 * Secure Admin Gateway Client Controller for PSP MES Dashboard
 */

const state = {
  theme: 'dark',
  mode: 'login' // 'login' or 'signup'
};

// ==================== COMPANY EMAIL DOMAIN RESTRICTION ====================
const ALLOWED_DOMAIN = '@plasmaspray.co.in';
const ACCESS_DENIED_MSG = 'Only Plasma Spray company email addresses are allowed.';

function isCompanyEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const cleanEmail = email.toLowerCase().trim();
  return cleanEmail.endsWith(ALLOWED_DOMAIN) || cleanEmail === 'aryankhandare2005@gmail.com';
}

/**
 * Force logout: clears all session data, signs out of Firebase if available, and redirects to login.
 */
function forceUnauthorizedLogout(errorMessage) {
  // Clear local session
  localStorage.removeItem('psp_logged_in_user');
  // Sign out of Firebase if available
  try {
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth()) {
      firebase.auth().signOut();
    }
  } catch (e) { /* ignore */ }
  // Show error and redirect
  if (errorMessage) {
    showErrorState(errorMessage);
  }
}

// Check if running in local mock mode
function isMockMode() {
  return !firebaseConfig.apiKey || firebaseConfig.apiKey.includes("YOUR_FIREBASE_") || localStorage.getItem("psp_auth_mock") === "true";
}

// ==================== MOCK DB USER INITIALIZATION ====================
const MOCK_DB = {
  init() {
    if (!localStorage.getItem('mock_db_users') || 
        !localStorage.getItem('mock_db_users').includes("gt@plasmaspray.co.in") || 
        localStorage.getItem('mock_db_users').includes('"email":"vg@plasmaspray.co.in","role":"operator"')) {
      const seedUsers = [
        { uid: "uid-super-admin", email: "admin@plasmaspray.co.in", role: "super_admin", department: "All", active: true, emailVerified: true },
        { uid: "uid-production-admin", email: "production@plasmaspray.co.in", role: "production_admin", department: "All", active: true, emailVerified: true },
        { uid: "uid-hr-admin", email: "hr@plasmaspray.co.in", role: "hr_admin", department: "All", active: true, emailVerified: true },
        { uid: "uid-quality-admin", email: "quality@plasmaspray.co.in", role: "quality_admin", department: "All", active: true, emailVerified: true },
        { uid: "uid-masking-operator", email: "masking@plasmaspray.co.in", role: "operator", department: "Masking", active: true, emailVerified: true },
        { uid: "uid-spraying-operator", email: "spraying@plasmaspray.co.in", role: "operator", department: "Spraying", active: true, emailVerified: true },
        { uid: "uid-grinding-operator", email: "grinding@plasmaspray.co.in", role: "operator", department: "Grinding", active: true, emailVerified: true },
        { uid: "uid-polishing-operator", email: "polishing@plasmaspray.co.in", role: "operator", department: "Polishing", active: true, emailVerified: true },
        { uid: "uid-gt-operator", email: "gt@plasmaspray.co.in", role: "quality_admin", department: "Inspection", active: true, emailVerified: true },
        { uid: "uid-vg-operator", email: "vg@plasmaspray.co.in", role: "quality_admin", department: "Inspection", active: true, emailVerified: true },
        { uid: "uid-mf-operator", email: "mf@plasmaspray.co.in", role: "quality_admin", department: "Inspection", active: true, emailVerified: true },
        { uid: "uid-sj-operator", email: "sj@plasmaspray.co.in", role: "quality_admin", department: "Inspection", active: true, emailVerified: true },
        { uid: "uid-jn-operator", email: "jn@plasmaspray.co.in", role: "quality_admin", department: "Inspection", active: true, emailVerified: true },
        { uid: "uid-laxmi-operator", email: "laxmi@plasmaspray.co.in", role: "quality_admin", department: "Inspection", active: true, emailVerified: true },
        { uid: "uid-suspended", email: "inactive@plasmaspray.co.in", role: "operator", department: "Masking", active: false, emailVerified: true }
      ];
      localStorage.setItem('mock_db_users', JSON.stringify(seedUsers));
      
      const seedPasswords = {
        "admin@plasmaspray.co.in": "admin123",
        "production@plasmaspray.co.in": "prod123",
        "hr@plasmaspray.co.in": "hr123",
        "quality@plasmaspray.co.in": "quality123",
        "masking@plasmaspray.co.in": "mask123",
        "spraying@plasmaspray.co.in": "spray123",
        "grinding@plasmaspray.co.in": "grind123",
        "polishing@plasmaspray.co.in": "polish123",
        "gt@plasmaspray.co.in": "gt123",
        "vg@plasmaspray.co.in": "vg123",
        "mf@plasmaspray.co.in": "mf123",
        "sj@plasmaspray.co.in": "sj123",
        "jn@plasmaspray.co.in": "jn123",
        "laxmi@plasmaspray.co.in": "laxmi123",
        "inactive@plasmaspray.co.in": "inactive123"
      };
      localStorage.setItem('mock_db_passwords', JSON.stringify(seedPasswords));
    }
  },
  getUsers() {
    return JSON.parse(localStorage.getItem('mock_db_users') || '[]');
  },
  saveUsers(users) {
    localStorage.setItem('mock_db_users', JSON.stringify(users));
  },
  getPasswords() {
    return JSON.parse(localStorage.getItem('mock_db_passwords') || '{}');
  },
  addUser(user, password) {
    const users = this.getUsers();
    users.push(user);
    this.saveUsers(users);

    const passwords = this.getPasswords();
    passwords[user.email] = password;
    localStorage.setItem('mock_db_passwords', JSON.stringify(passwords));
  }
};

// ==================== FIREBASE SDK DYNAMIC LOADER ====================
function loadFirebaseSDKs(callback) {
  if (isMockMode()) {
    callback();
    return;
  }
  
  const sApp = document.createElement("script");
  sApp.src = "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js";
  sApp.onload = () => {
    const sAuth = document.createElement("script");
    sAuth.src = "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js";
    sAuth.onload = () => {
      const sStore = document.createElement("script");
      sStore.src = "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js";
      sStore.onload = callback;
      document.head.appendChild(sStore);
    };
    document.head.appendChild(sAuth);
  };
  sApp.onerror = () => {
    console.warn("Firebase CDN failed to load. Falling back to local Mock Mode.");
    localStorage.setItem("psp_auth_mock", "true");
    callback();
  };
  document.head.appendChild(sApp);
}

// ==================== AUTH ACTIONS ====================
let pendingVerifyUserEmail = "";

// Show login screen
function showLoginScreen() {
  document.getElementById("verify-email-screen").classList.add("hidden");
  document.getElementById("pending-approval-screen").classList.add("hidden");
  document.getElementById("success-screen").classList.add("hidden");
  document.getElementById("loading-overlay").classList.add("hidden");
  
  const loginForm = document.getElementById("login-form");
  loginForm.classList.remove("hidden");
  document.getElementById("btn-submit-login").disabled = false;
  
  // Reselect login tab
  document.getElementById("tab-login").click();
}

// Resend verification email
async function resendVerificationEmail() {
  const isMock = isMockMode();
  if (isMock) {
    showToast("Notice", "Verification email resent (simulated).", "success");
    return;
  }
  
  // In live firebase mode, if we logged them out, we need to sign in again to resend,
  // but if auth user exists, we send verification email.
  const user = firebase.auth().currentUser;
  if (user) {
    try {
      await user.sendEmailVerification();
      showToast("Success", "Verification email has been resent to your corporate email.", "success");
    } catch (err) {
      showToast("Error", err.message, "danger");
    }
  } else {
    showToast("Notice", "Please try logging in with your email and password first, which will trigger verification email again if not verified.", "danger");
    showLoginScreen();
  }
}

// Simulate verification click (Mock Mode only)
function simulateEmailVerificationClick() {
  if (!pendingVerifyUserEmail) {
    showToast("Error", "No pending registration found to verify.", "danger");
    return;
  }
  
  const users = MOCK_DB.getUsers();
  const user = users.find(u => u.email.toLowerCase() === pendingVerifyUserEmail.toLowerCase());
  if (user) {
    user.emailVerified = true;
    MOCK_DB.saveUsers(users);
    showToast("Success", "Email verified successfully (simulated)!", "success");
    
    // Redirect to Pending Approval Screen
    document.getElementById("verify-email-screen").classList.add("hidden");
    document.getElementById("pending-approval-screen").classList.remove("hidden");
  } else {
    showToast("Error", "User not found in local mock database.", "danger");
  }
}

// Local audit log helper for logins
function logLocalAuthAction(userEmail, action, role, dept) {
  try {
    const localLogs = localStorage.getItem("mes_audit_logs");
    let auditLogs = localLogs ? JSON.parse(localLogs) : [];
    const newLog = {
      timestamp: new Date().toISOString(),
      user: userEmail,
      role: role || "N/A",
      department: dept || "System",
      kpNumber: "N/A",
      action: action
    };
    auditLogs.unshift(newLog);
    localStorage.setItem("mes_audit_logs", JSON.stringify(auditLogs));
  } catch (e) {
    console.error("Failed to write local auth audit log:", e);
  }
}

async function handleAuthAction(email, password, confirmPassword, role, department, fullname) {
  showLoginAlert(""); // Clear alert
  
  const loginForm = document.getElementById("login-form");
  const loadingOverlay = document.getElementById("loading-overlay");
  const btnSubmit = document.getElementById("btn-submit-login");
  const statusText = document.getElementById("loading-status-text");

  // ===== COMPANY EMAIL DOMAIN VALIDATION (applies to BOTH login and signup) =====
  if (!isCompanyEmail(email)) {
    showToast("Access Denied", "Only Plasma Spray company email addresses are allowed.", "danger");
    return;
  }

  // Validate signup constraints
  if (state.mode === 'signup') {
    if (!fullname || fullname.trim() === "") {
      showToast("Validation Error", "Full Name is required.", "danger");
      return;
    }
    if (password !== confirmPassword) {
      showToast("Validation Error", "Passwords do not match. Please verify.", "danger");
      return;
    }
    if (password.length < 6) {
      showToast("Validation Error", "Password must be at least 6 characters long.", "danger");
      return;
    }
  }

  loginForm.classList.add("hidden");
  loadingOverlay.classList.remove("hidden");
  btnSubmit.disabled = true;

  if (isMockMode()) {
    // ==================== MOCK AUTH ====================
    if (state.mode === 'login') {
      statusText.textContent = "Verifying credentials...";
      setTimeout(() => {
        const users = MOCK_DB.getUsers();
        const passwords = MOCK_DB.getPasswords();
        const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
        
        if (!user || passwords[email] !== password) {
          showErrorState("Invalid credentials. Try admin@plasmaspray.co.in / admin123");
          return;
        }

        // Check verification status
        if (!user.emailVerified) {
          pendingVerifyUserEmail = user.email;
          loadingOverlay.classList.add("hidden");
          document.getElementById("verify-email-screen").classList.remove("hidden");
          document.getElementById("btn-simulate-verify").style.display = "block";
          showToast("Notice", "Please verify your company email before logging in.", "danger");
          return;
        }

        // Check approval status
        if (!user.active) {
          loadingOverlay.classList.add("hidden");
          document.getElementById("pending-approval-screen").classList.remove("hidden");
          showToast("Access Denied", "Your account is awaiting administrator approval.", "danger");
          return;
        }

        statusText.textContent = "Authenticating profile...";
        setTimeout(() => {
          // Set session
          const sessionUser = {
            uid: user.uid,
            email: user.email,
            role: user.role,
            department: user.department,
            name: user.name || user.email.split('@')[0],
            active: true
          };
          localStorage.setItem("psp_logged_in_user", JSON.stringify(sessionUser));
          logLocalAuthAction(user.email, "Login Success (Mock)", user.role, user.department);
          
          showSuccessState("index.html", "Authentication Approved");
        }, 1000);
      }, 1200);

    } else {
      // Mock Sign Up
      statusText.textContent = "Validating registration rules...";
      setTimeout(() => {
        const users = MOCK_DB.getUsers();
        
        if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
          showErrorState("User email is already registered.");
          return;
        }

        const newUid = `uid-${Math.floor(100000 + Math.random() * 900000)}`;
        const newUser = {
          uid: newUid,
          name: fullname,
          email: email.toLowerCase().trim(),
          role: "pending",
          department: "pending",
          active: false,
          emailVerified: false,
          createdAt: new Date().toISOString()
        };

        MOCK_DB.addUser(newUser, password);
        pendingVerifyUserEmail = newUser.email;
        
        statusText.textContent = "Sending verification email (simulated)...";
        setTimeout(() => {
          loadingOverlay.classList.add("hidden");
          document.getElementById("verify-email-screen").classList.remove("hidden");
          document.getElementById("btn-simulate-verify").style.display = "block";
          showToast("Success", "A verification link has been sent to your company email (Simulated). Click Simulate Verify to verify.", "success");
        }, 1000);
      }, 1200);
    }

  } else {
    // ==================== LIVE FIREBASE AUTH ====================
    try {
      const db = firebase.firestore();
      
      if (state.mode === 'login') {
        statusText.textContent = "Connecting to Authentication server...";
        const userCredential = await firebase.auth().signInWithEmailAndPassword(email, password);
        const user = userCredential.user;

        // ===== DOMAIN CHECK after Firebase auth =====
        if (!isCompanyEmail(user.email)) {
          await firebase.auth().signOut();
          localStorage.removeItem('psp_logged_in_user');
          showErrorState(ACCESS_DENIED_MSG);
          return;
        }
        
        statusText.textContent = "Acquiring access levels...";
        
        let userProfile = null;
        try {
          const doc = await db.collection("users").doc(user.uid).get();
          if (!doc.exists) {
            // Auto-create missing profile
            const defaultProfile = {
              uid: user.uid,
              name: user.displayName || user.email.split('@')[0],
              email: user.email,
              role: "pending",
              department: "pending",
              active: false,
              emailVerified: user.emailVerified,
              createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            await db.collection("users").doc(user.uid).set(defaultProfile);
            userProfile = defaultProfile;
          } else {
            userProfile = doc.data();
            // Sync email verification to Firestore
            if (user.emailVerified && !userProfile.emailVerified) {
              await db.collection("users").doc(user.uid).update({ emailVerified: true });
              userProfile.emailVerified = true;
            }
          }
        } catch (firestoreErr) {
          console.warn("Firestore error:", firestoreErr);
          await firebase.auth().signOut();
          showErrorState("Security profile error. Please contact administrator.");
          return;
        }

        // ===== EMAIL VERIFICATION CHECK =====
        if (!user.emailVerified && !userProfile.emailVerified) {
          // Send verification email to currentUser if not sent recently, then log out
          try {
            await user.sendEmailVerification();
          } catch(e) {}
          await firebase.auth().signOut();
          loadingOverlay.classList.add("hidden");
          document.getElementById("verify-email-screen").classList.remove("hidden");
          document.getElementById("btn-simulate-verify").style.display = "none";
          showToast("Notice", "Please verify your company email before logging in.", "danger");
          return;
        }

        // ===== ADMIN APPROVAL CHECK =====
        if (userProfile.active !== true) {
          await firebase.auth().signOut();
          loadingOverlay.classList.add("hidden");
          document.getElementById("pending-approval-screen").classList.remove("hidden");
          showToast("Access Denied", "Your account is awaiting administrator approval.", "danger");
          return;
        }

        statusText.textContent = "Establishing security session...";
        const sessionUser = {
          uid: user.uid,
          email: user.email,
          role: userProfile.role,
          department: userProfile.department,
          name: userProfile.name || user.email.split('@')[0],
          active: true
        };
        localStorage.setItem("psp_logged_in_user", JSON.stringify(sessionUser));
        logLocalAuthAction(user.email, "Login Success", userProfile.role, userProfile.department);
        
        showSuccessState("index.html", "Authentication Approved");

      } else {
        // Live Firebase Sign Up
        statusText.textContent = "Creating authentication account...";
        const userCredential = await firebase.auth().createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;

        // ===== DOMAIN CHECK after Firebase signup =====
        if (!isCompanyEmail(user.email)) {
          try { await firebase.auth().currentUser.delete(); } catch(e) {}
          await firebase.auth().signOut();
          localStorage.removeItem('psp_logged_in_user');
          showErrorState(ACCESS_DENIED_MSG);
          return;
        }

        // Send Email Verification immediately
        statusText.textContent = "Triggering verification email...";
        await user.sendEmailVerification();

        statusText.textContent = "Creating profile database record...";
        const userProfile = {
          uid: user.uid,
          name: fullname,
          email: email.toLowerCase().trim(),
          role: "pending",
          department: "pending",
          active: false,
          emailVerified: false,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        try {
          await db.collection("users").doc(user.uid).set(userProfile);
        } catch (writeErr) {
          console.warn("Firestore profile creation error:", writeErr);
        }

        // Immediately logout to enforce email verification and super admin checks
        await firebase.auth().signOut();

        loadingOverlay.classList.add("hidden");
        document.getElementById("verify-email-screen").classList.remove("hidden");
        document.getElementById("btn-simulate-verify").style.display = "none";
        showToast("Success", "Account created! A verification link has been sent to your corporate email.", "success");
      }

    } catch (error) {
      console.error("Authentication error:", error);
      showErrorState(error.message);
    }
  }
}

// Handles Google/Apple social sign-in mock routing
async function handleSocialLogin(providerName) {
  showLoginAlert("");
  
  const loginForm = document.getElementById("login-form");
  const loadingOverlay = document.getElementById("loading-overlay");
  const statusText = document.getElementById("loading-status-text");

  const role = document.getElementById("login-role").value || "operator";
  const department = document.getElementById("login-dept").value || "Masking";

  if (isMockMode()) {
    const mockEmail = prompt(`Enter mock corporate email to simulate ${providerName === 'google' ? 'Google' : 'Apple'} Sign-In:`, 
                             `${providerName}-staff@plasmaspray.co.in`);
    
    if (!mockEmail || mockEmail.trim() === "") return;

    // ===== DOMAIN CHECK for social login mock =====
    if (!isCompanyEmail(mockEmail.trim())) {
      showErrorState(ACCESS_DENIED_MSG);
      return;
    }

    loginForm.classList.add("hidden");
    loadingOverlay.classList.remove("hidden");
    statusText.textContent = `Establishing connection to ${providerName} credential provider...`;

    setTimeout(() => {
      const users = MOCK_DB.getUsers();
      let user = users.find(u => u.email.toLowerCase() === mockEmail.toLowerCase().trim());

      if (!user) {
        // Check Super Admin constraint if signup role is super_admin
        if (role === 'super_admin') {
          const hasSuperAdmin = users.some(u => u.role === 'super_admin');
          if (hasSuperAdmin) {
            showErrorState("Super Admin account already exists.");
            return;
          }
        }

        const newUid = `uid-oauth-${Math.floor(100000 + Math.random() * 900000)}`;
        user = {
          uid: newUid,
          email: mockEmail.trim().toLowerCase(),
          role: role,
          department: role === 'super_admin' ? 'All' : department,
          active: true
        };
        MOCK_DB.addUser(user, "oauth_mock_password");
        statusText.textContent = "Creating profile and linking OAuth credentials...";
      } else {
        statusText.textContent = "Verifying profile permissions...";
      }

      if (!user.active) {
        showErrorState("Access Denied. Account is suspended.");
        return;
      }

      setTimeout(() => {
        const sessionUser = {
          uid: user.uid,
          email: user.email,
          role: user.role,
          department: user.department,
          name: user.email.split('@')[0],
          active: true
        };
        localStorage.setItem("psp_logged_in_user", JSON.stringify(sessionUser));
        logLocalAuthAction(user.email, `Social Login Success via ${providerName}`, user.role, user.department);
        
        showSuccessState("index.html", "OAuth Handshake Success");
      }, 1000);
    }, 1200);

  } else {
    // Production Firebase Social Login
    try {
      let provider;
      if (providerName === 'google') {
        provider = new firebase.auth.GoogleAuthProvider();
      } else if (providerName === 'apple') {
        provider = new firebase.auth.OAuthProvider('apple.com');
      } else {
        throw new Error("Provider not supported.");
      }

      loginForm.classList.add("hidden");
      loadingOverlay.classList.remove("hidden");
      statusText.textContent = `Launching secure browser popups for ${providerName}...`;

      const userCredential = await firebase.auth().signInWithPopup(provider);
      const user = userCredential.user;

      // ===== DOMAIN CHECK after social Firebase auth =====
      if (!isCompanyEmail(user.email)) {
        await firebase.auth().signOut();
        localStorage.removeItem('psp_logged_in_user');
        showErrorState(ACCESS_DENIED_MSG);
        return;
      }

      statusText.textContent = "Connecting user records...";
      const db = firebase.firestore();
      const docRef = db.collection("users").doc(user.uid);
      const doc = await docRef.get();

      if (!doc.exists) {
        // Validate Super Admin singleton before setting up new social user
        if (role === 'super_admin') {
          const superQuery = await db.collection("users").where("role", "==", "super_admin").limit(1).get();
          if (!superQuery.empty) {
            await firebase.auth().signOut();
            showErrorState("Super Admin account already exists.");
            return;
          }
        }

        statusText.textContent = "Creating authorization profile...";
        const userProfile = {
          uid: user.uid,
          email: user.email,
          role: role,
          department: role === 'super_admin' ? 'All' : department,
          active: true,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await docRef.set(userProfile);
      } else {
        const existingProfile = doc.data();
        if (existingProfile.active !== true) {
          await firebase.auth().signOut();
          showErrorState("Access Denied. Account has been deactivated.");
          return;
        }
      }

      const activeProfile = doc.exists ? doc.data() : { role, department: role === 'super_admin' ? 'All' : department };
      const sessionUser = {
        uid: user.uid,
        email: user.email,
        role: activeProfile.role,
        department: activeProfile.department,
        name: user.displayName || user.email.split('@')[0],
        active: true
      };
      localStorage.setItem("psp_logged_in_user", JSON.stringify(sessionUser));
      logLocalAuthAction(user.email, `Social Login Success via ${providerName}`, activeProfile.role, activeProfile.department);
      
      showSuccessState("index.html", "OAuth Connection Complete");

    } catch (error) {
      console.error(`${providerName} login transaction error:`, error);
      showErrorState(error.message);
    }
  }
}

// Show error messages with shake animation
function showErrorState(errorMsg) {
  document.getElementById("loading-overlay").classList.add("hidden");
  document.getElementById("login-form").classList.remove("hidden");
  document.getElementById("btn-submit-login").disabled = false;
  showLoginAlert(errorMsg, "danger");

  const card = document.getElementById("login-card");
  card.classList.remove("shake");
  void card.offsetWidth; // Trigger reflow to restart animation
  card.classList.add("shake");
  setTimeout(() => card.classList.remove("shake"), 400);
}

// Show success and trigger redirect
function showSuccessState(redirectUrl, titleText) {
  document.getElementById("loading-overlay").classList.add("hidden");
  
  const successScreen = document.getElementById("success-screen");
  document.getElementById("success-title").textContent = titleText;
  successScreen.classList.remove("hidden");
  
  const manualBtn = document.getElementById("manual-redirect-btn");
  manualBtn.href = redirectUrl;
  
  setTimeout(() => {
    window.location.href = redirectUrl;
  }, 1200);
}

// Theme manager
function initTheme() {
  const savedTheme = localStorage.getItem("mes_theme") || 'light';
  setTheme(savedTheme);
  
  const themeToggleBtn = document.getElementById("theme-toggle-btn");
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const nextTheme = document.body.classList.contains("dark-theme") ? 'light' : 'dark';
      setTheme(nextTheme);
    });
  }
}

function setTheme(theme) {
  const themeIcon = document.getElementById("theme-icon");
  if (theme === 'dark') {
    document.body.classList.add("dark-theme");
    localStorage.setItem("mes_theme", "dark");
    if (themeIcon) themeIcon.textContent = "☀️";
  } else {
    document.body.classList.remove("dark-theme");
    localStorage.setItem("mes_theme", "light");
    if (themeIcon) themeIcon.textContent = "🌙";
  }
}

// Info Slider
function initSlideshow() {
  const slides = document.querySelectorAll(".slide");
  const captions = document.querySelectorAll(".slide-caption");
  const indicators = document.querySelectorAll(".indicator");
  if (slides.length <= 1) return;
  
  let currentIndex = 0;
  
  setInterval(() => {
    // Remove active from current
    slides[currentIndex].classList.remove("active");
    if (captions[currentIndex]) captions[currentIndex].classList.remove("active");
    if (indicators[currentIndex]) indicators[currentIndex].classList.remove("active");
    
    // Advance index
    currentIndex = (currentIndex + 1) % slides.length;
    
    // Add active to next
    slides[currentIndex].classList.add("active");
    if (captions[currentIndex]) captions[currentIndex].classList.add("active");
    if (indicators[currentIndex]) indicators[currentIndex].classList.add("active");
  }, 5000);
}

// Toast System
function showToast(title, message, type = 'danger') {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  
  let iconSvg = "";
  if (type === 'danger') {
    iconSvg = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 18px; height: 18px; color: #ef4444; flex-shrink: 0;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
  } else {
    iconSvg = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 18px; height: 18px; color: #10b981; flex-shrink: 0;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
  }

  toast.innerHTML = `
    ${iconSvg}
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-desc">${message}</div>
    </div>
    <button type="button" class="toast-close">&times;</button>
  `;

  container.appendChild(toast);

  setTimeout(() => toast.classList.add("show"), 10);

  const timer = setTimeout(() => dismissToast(toast), 4000);

  toast.querySelector(".toast-close").addEventListener("click", () => {
    clearTimeout(timer);
    dismissToast(toast);
  });
}

function dismissToast(toast) {
  toast.classList.remove("show");
  setTimeout(() => toast.remove(), 300);
}

function showLoginAlert(msg, level = "danger") {
  if (!msg) return;
  const title = level === 'danger' ? 'Access Denied' : 'Notice';
  showToast(title, msg, level);
}

// ==================== INITIALIZER ====================
document.addEventListener("DOMContentLoaded", () => {
  MOCK_DB.init();
  initTheme();
  initSlideshow();

  const tabLogin = document.getElementById("tab-login");
  const tabSignup = document.getElementById("tab-signup");
  const fullnameGroup = document.getElementById("fullname-group");
  const confirmPasswordGroup = document.getElementById("confirm-password-group");
  const signupRoleGroup = document.getElementById("signup-role-group");
  const signupDeptGroup = document.getElementById("signup-dept-group");
  const btnSubmit = document.getElementById("btn-submit-login");

  tabLogin.addEventListener("click", () => {
    state.mode = 'login';
    tabLogin.classList.add("active");
    tabSignup.classList.remove("active");
    fullnameGroup.classList.add("hidden");
    confirmPasswordGroup.classList.add("hidden");
    signupRoleGroup.classList.add("hidden");
    signupDeptGroup.classList.add("hidden");
    
    document.getElementById("login-fullname").required = false;
    document.getElementById("login-confirm-password").required = false;
    document.getElementById("login-role").required = false;
    document.getElementById("login-dept").required = false;
    
    btnSubmit.innerHTML = '<span class="btn-text">Sign In</span><span class="btn-arrow">→</span>';
    const formTitle = document.getElementById("form-title");
    if (formTitle) formTitle.textContent = "Sign in to your account";
  });

  tabSignup.addEventListener("click", () => {
    state.mode = 'signup';
    tabSignup.classList.add("active");
    tabLogin.classList.remove("active");
    fullnameGroup.classList.remove("hidden");
    confirmPasswordGroup.classList.remove("hidden");
    // Explicitly hide role & department groups from employee signup flow
    signupRoleGroup.classList.add("hidden");
    signupDeptGroup.classList.add("hidden");
    
    document.getElementById("login-fullname").required = true;
    document.getElementById("login-confirm-password").required = true;
    document.getElementById("login-role").required = false;
    document.getElementById("login-dept").required = false;
    
    btnSubmit.innerHTML = '<span class="btn-text">Create Account</span><span class="btn-arrow">→</span>';
    const formTitle = document.getElementById("form-title");
    if (formTitle) formTitle.textContent = "Create your account";
  });
  
  // Filter department choices based on selected signup role
  const roleSelect = document.getElementById("login-role");
  const deptSelect = document.getElementById("login-dept");
  roleSelect.addEventListener("change", (e) => {
    const selectedRole = e.target.value;
    deptSelect.innerHTML = "";
    
    if (selectedRole === 'operator') {
      deptSelect.innerHTML = `
        <option value="Masking">Masking Operator</option>
        <option value="Spraying">Spraying Operator</option>
        <option value="Grinding">Grinding Operator</option>
        <option value="Polishing">Polishing Operator</option>
      `;
    } else {
      deptSelect.innerHTML = `
        <option value="All">All Departments (Admin / Manager / HR / Quality)</option>
        <option value="Production">Production</option>
        <option value="HR">HR</option>
        <option value="Quality">Quality</option>
      `;
    }
  });

  document.getElementById("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const pass = document.getElementById("login-password").value;
    const confirmPass = document.getElementById("login-confirm-password").value;
    const role = document.getElementById("login-role").value;
    const department = document.getElementById("login-dept").value;
    const fullname = document.getElementById("login-fullname").value.trim();
    
    handleAuthAction(email, pass, confirmPass, role, department, fullname);
  });

  // Action button events for verification & pending approval screens
  document.getElementById("btn-simulate-verify").addEventListener("click", () => {
    simulateEmailVerificationClick();
  });

  document.getElementById("btn-resend-verify").addEventListener("click", () => {
    resendVerificationEmail();
  });

  document.getElementById("btn-verify-back-to-login").addEventListener("click", () => {
    showLoginScreen();
  });

  document.getElementById("btn-pending-back-to-login").addEventListener("click", () => {
    showLoginScreen();
  });

  document.getElementById("btn-google-login").addEventListener("click", () => {
    handleSocialLogin('google');
  });

  document.getElementById("btn-apple-login").addEventListener("click", () => {
    handleSocialLogin('apple');
  });

  const updateMockModeUI = () => {
    const link = document.getElementById("toggle-mock-mode-link");
    if (!link) return;
    if (isMockMode()) {
      link.textContent = "Switch to Live Firebase Mode";
      link.style.color = "#f43f5e";
    } else {
      link.textContent = "Switch to Local Mock Mode";
      link.style.color = "#10b981";
    }
  };

  updateMockModeUI();

  const mockLink = document.getElementById("toggle-mock-mode-link");
  if (mockLink) {
    mockLink.addEventListener("click", (e) => {
      e.preventDefault();
      if (isMockMode()) {
        localStorage.removeItem("psp_auth_mock");
        showToast("Mode Changed", "Switched to Live Firebase Mode.", "success");
      } else {
        localStorage.setItem("psp_auth_mock", "true");
        showToast("Mode Changed", "Switched to Local Mock Mode.", "success");
      }
      updateMockModeUI();
      setTimeout(() => location.reload(), 800);
    });
  }

  loadFirebaseSDKs(() => {
    if (!isMockMode()) {
      firebase.initializeApp(firebaseConfig);
      console.log("Firebase Auth initialized in secure production mode.");
    } else {
      console.log("Running in secure local mock gate mode.");
    }
  });
});
