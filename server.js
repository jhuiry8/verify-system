require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;
const dataFile = "data.json";

// 固定域名設定：直接使用固定的域名作為 OAuth2 重導向 URL
const FIXED_DOMAIN = "https://verify.mcfox.us.kg";
const REDIRECT_URI = FIXED_DOMAIN + "/auth/callback";

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public")); // 提供前端靜態檔案

// 讀取及儲存使用者資料到 JSON 檔
const loadData = () => {
  return fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile)) : [];
};
const saveData = (data) => {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
};

// 1. 首頁：提供帶有 reCAPTCHA 的登入頁面
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// 2. OAuth2 登入路由：先驗證 reCAPTCHA token，再重導向至 Discord 授權頁面
app.get("/auth/discord", async (req, res) => {
  const captchaToken = req.query.captchaToken;
  console.log("收到的 captchaToken:", captchaToken);
  if (!captchaToken) {
    return res.status(400).send("缺少 reCAPTCHA 驗證資料");
  }
  // 後續 reCAPTCHA 驗證邏輯...
  try {
    // 驗證 reCAPTCHA token
    const secret = process.env.RECAPTCHA_SECRET;
    const verifyURL = `https://www.google.com/recaptcha/api/siteverify?secret=${secret}&response=${captchaToken}`;
    const captchaResponse = await axios.post(verifyURL);
    if (!captchaResponse.data.success) {
      return res.status(400).send("reCAPTCHA 驗證失敗");
    }
  } catch (err) {
    console.error("reCAPTCHA 驗證錯誤:", err);
    return res.status(500).send("reCAPTCHA 驗證錯誤");
  }
  
  // 驗證通過，重導向至 Discord OAuth2 授權頁面
  const discordAuthURL = `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join`;
  res.redirect(discordAuthURL);
});

// 3. OAuth2 回呼：處理 Discord 回傳的 code，取得 access token 與使用者資訊，並記錄到 JSON
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("無效的請求，缺少 code");
  try {
    // 使用 code 交換 access token
    const tokenResponse = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const accessToken = tokenResponse.data.access_token;
    // 取得 Discord 使用者資訊
    const userResponse = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = userResponse.data;
    // 取得使用者 IP
    const userIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    let users = loadData();
    // 如果資料庫中尚未記錄該使用者，則新增記錄
    if (!users.some(u => u.id === user.id)) {
      users.push({ id: user.id, username: user.username, ip: userIP, timestamp: Date.now() });
      saveData(users);
      console.log(`新增使用者 ${user.username} (ID: ${user.id}) 到 JSON 檔`);
    } else {
      console.log(`使用者 ${user.username} (ID: ${user.id}) 已存在於 JSON 檔中`);
    }
    res.send("✅ 驗證成功，請返回 Discord");
  } catch (error) {
    console.error("OAuth2 錯誤:", error.response ? error.response.data : error.message);
    res.status(500).send("❌ 驗證失敗");
  }
});

// 4. 查詢使用者驗證狀態的 API（返回 JSON 格式的使用者資料）
app.get("/user/:id", (req, res) => {
  let users = loadData();
  let user = users.find(u => u.id === req.params.id);
  res.json(user || { verified: false });
});

// 5. 後臺管理 API：密碼驗證後，回傳依 IP 分組的使用者資料（JSON 格式）
app.post("/admin", (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: "❌ 密碼錯誤" });
  }
  let users = loadData();
  const groupedByIP = users.reduce((acc, user) => {
    acc[user.ip] = acc[user.ip] || [];
    acc[user.ip].push(user);
    return acc;
  }, {});
  res.json(groupedByIP);
});

// 啟動 HTTP 伺服器
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Server running on ${FIXED_DOMAIN}:${PORT}`);
});


// 6. Discord Bot 部分
// 當新成員加入時，查詢 /user/<id> API，若已驗證則自動給予指定身份組
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

discordClient.once("ready", () => {
  console.log(`🤖 Discord Bot 已上線：${discordClient.user.tag}`);
});

discordClient.on("guildMemberAdd", async (member) => {
  try {
    // 呼叫 /user API，使用固定域名確保外部存取
    const response = await axios.get(`${FIXED_DOMAIN}/user/${member.id}`);
    if (response.data && response.data.id) {
      const role = member.guild.roles.cache.get(process.env.DISCORD_ROLE_ID);
      if (role) {
        await member.roles.add(role);
        console.log(`已給予 ${member.user.tag} 身份組`);
      } else {
        console.log("身份組 ID 設定錯誤或該身份組不存在");
      }
    }
  } catch (error) {
    console.error("Discord Bot 身份組指派錯誤:", error);
  }
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);
