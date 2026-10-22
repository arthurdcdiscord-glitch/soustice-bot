require('dotenv').config();
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Verifique DISCORD_TOKEN e CLIENT_ID no .env');
  process.exit(1);
}

const app = express();
app.use(express.json());

// ✅ Libera acesso do site Netlify
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// === DADOS ===
const fs = require('fs');
const DADOS_PATH = path.join(__dirname, 'dados.json');

function carregarDados() {
  try { return JSON.parse(fs.readFileSync(DADOS_PATH, 'utf8')); }
  catch { return { ponto: { sessoes: {}, total_horas: {} }, set: { solicitacoes: {}, setados: {} } }; }
}
let DADOS = carregarDados();

function formatarTempo(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}min`;
}

// === CLIENT DISCORD ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// === API /api/stats ===
app.get('/api/stats', (req, res) => {
  res.json({
    servidores: client.guilds.cache.size,
    usuarios: client.guilds.cache.reduce((s, g) => s + (g.memberCount || 0), 0),
    ranking: Object.entries(DADOS.ponto.total_horas || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([userId, ms]) => {
        const usuario = client.users.cache.get(userId);
        const nome = usuario ? `@${usuario.username}` : `<@${userId}>`;
        const equipe = (DADOS.set.setados && DADOS.set.setados[userId]) || '—';
        return { usuario: nome, horas: formatarTempo(ms), equipe };
      })
  });
});

// === INICIAR ===
app.listen(PORT, () => {
  console.log(`🌐 Servidor próprio rodando na porta ${PORT}`);
  console.log(`📊 API: http://SEU-IP:${PORT}/api/stats`);
});

client.once('ready', () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  client.user.setActivity('SOUSTICE System', { type: 3 });
});

client.login(TOKEN).catch(e => {
  console.error('❌ Erro no login:', e.message);
  process.exit(1);
});

// Mantém tudo do seu index.js
require('./index.js');