require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const axios = require("axios");

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));

client.on("guildMemberAdd", async (member) => {
    try {
        const response = await axios.get(`http://localhost:3000/user/${member.id}`);
        if (response.data && response.data.id) {
            const role = member.guild.roles.cache.get(process.env.DISCORD_ROLE_ID);
            if (role) await member.roles.add(role);
        }
    } catch (error) {
        console.error("身份組錯誤:", error);
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
