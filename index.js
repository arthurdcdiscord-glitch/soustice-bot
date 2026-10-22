require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http'); // ← servidor pra conectar com o site depois
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

// ============================================================
//  CONFIGURAÇÕES
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'config.json');

function configPadrao() {
  return {
    bot: {
      nome: 'SOUSTICE',
      versao: '0.1.0',
      cor_destaque: '7c5cff',
      url_site: 'https://seu-site-aqui.com',
      embed_painel_titulo: '⏱️ Bate-Ponto',
      embed_painel_descricao: 'Bata seu Ponto aqui ou veja suas informações/ranking',
      thumbnail_url: ''
    },
    servidor_id: '',
    cargo_confiavel: null,
    descricao_bot: 'Sistema de gerenciamento de equipes e controle de presença.',
    ponto: {
      ativo: true,
      canal_logs_inicio_fim: null,
      canal_logs_pausas: null,
      canal_logs_cancelados: null,
      canal_painel_publico: null,
      tempo_pausa_maxima_segundos: 60,
      banner_painel_publico: '',
      banner_inicio: '',
      banner_fim: '',
      cargos_permitidos: [],
      menu_placeholder: 'Selecione uma opção',
      menu_opcoes: [
        { label: '▶️ Iniciar Ponto', valor: 'iniciar' },
        { label: '🏆 Ver Ranking', valor: 'ranking' }
      ]
    },
    set: {
      ativo: true,
      cargos_setagem: [],
      canal_logs: null,
      canal_painel: null,
      equipes: [{ nome: 'TDMM', eqps: ['Eqp1'] }],
      expiracao_horas: 12,
      embed_titulo: '📋 Solicitar SET',
      embed_descricao: 'Clique no botão abaixo para solicitar uma setagem.',
      banner: '',
      botao_label: '📋 Pedir Set'
    }
  };
}

function carregarConfig() {
  let cfg;
  try {
    const existente = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const padrao = configPadrao();
    cfg = {
      ...padrao,
      ...existente,
      bot: { ...padrao.bot, ...(existente.bot || {}) },
      ponto: { ...padrao.ponto, ...(existente.ponto || {}) },
      set: { ...padrao.set, ...(existente.set || {}) }
    };
  } catch (erro) {
    cfg = configPadrao();
  }
  if (!Array.isArray(cfg.set.equipes)) cfg.set.equipes = [];
  cfg.set.equipes = cfg.set.equipes.map(function (e) {
    if (typeof e === 'string') return { nome: e, eqps: ['Eqp1'] };
    return e;
  });
  if (cfg.set.equipes.length === 0) cfg.set.equipes = [{ nome: 'TDMM', eqps: ['Eqp1'] }];
  if (!Array.isArray(cfg.set.cargos_setagem)) cfg.set.cargos_setagem = [];
  if (!Array.isArray(cfg.ponto.menu_opcoes) || cfg.ponto.menu_opcoes.length === 0) {
    cfg.ponto.menu_opcoes = [
      { label: '▶️ Iniciar Ponto', valor: 'iniciar' },
      { label: '🏆 Ver Ranking', valor: 'ranking' }
    ];
  }
  return cfg;
}

let CFG = carregarConfig();

function salvarConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2));
  console.log('💾 Config salva em disco.');
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Verifique o arquivo .env (DISCORD_TOKEN e CLIENT_ID)');
  process.exit(1);
}

// ============================================================
//  DADOS (sessões de ponto e solicitações de set)
// ============================================================
const DADOS_PATH = path.join(__dirname, 'dados.json');

function dadosPadrao() {
  return {
    ponto: { sessoes: {}, total_horas: {} },
    set: { solicitacoes: {}, setados: {} } // setados = { userId: "EQP 1 \"TDMM\"" }
  };
}

function carregarDados() {
  try {
    return { ...dadosPadrao(), ...JSON.parse(fs.readFileSync(DADOS_PATH, 'utf8')) };
  } catch (erro) {
    return dadosPadrao();
  }
}

let DADOS = carregarDados();
if (!DADOS.set.setados) DADOS.set.setados = {}; // garante que existe
let salvandoDados = false;

function salvarDados() {
  if (salvandoDados) return;
  salvandoDados = true;
  fs.writeFile(DADOS_PATH, JSON.stringify(DADOS, null, 2), function () {
    salvandoDados = false;
  });
}

// ============================================================
//  HELPERS GERAIS
// ============================================================
function formatarTempo(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function unix(ms) {
  return Math.floor(ms / 1000);
}

function str(valor, fallback) {
  if (fallback === undefined) fallback = '';
  if (valor === null || valor === undefined) return fallback;
  return String(valor);
}

function abrirModalSeguro(interacao, modal) {
  return interacao.showModal(modal).catch(async function (erro) {
    console.error('❌ Erro ao abrir modal:', erro.message);
    if (!interacao.replied && !interacao.deferred) {
      await interacao.reply({ content: '⚠️ Não foi possível abrir a janela. Tente novamente.', ephemeral: true }).catch(function () {});
    }
  });
}

// ============================================================
//  API ROBLOX
// ============================================================
function requisicaoHTTP(opcoes, corpo) {
  return new Promise(function (resolve, reject) {
    const req = https.request(opcoes, function (res) {
      let dados = '';
      res.on('data', function (pedaco) { dados += pedaco; });
      res.on('end', function () {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(dados) });
        } catch (e) {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('error', reject);
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

async function buscarRoblox(nick) {
  try {
    console.log('[SET] Buscando nick no Roblox:', nick);
    const resposta = await requisicaoHTTP(
      { hostname: 'users.roblox.com', path: '/v1/usernames/users', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { usernames: [nick], excludeBannedUsers: false }
    );
    const usuario = resposta.body && resposta.body.data && resposta.body.data[0];
    if (!usuario || !usuario.id) {
      console.log('[SET] Nick não encontrado.');
      return null;
    }
    const headshotRes = await requisicaoHTTP({
      hostname: 'thumbnails.roblox.com',
      path: '/v1/users/avatar-headshot?userIds=' + usuario.id + '&size=150x150&format=Png&isCircular=false',
      method: 'GET'
    });
    const info = {
      id: usuario.id,
      nome: usuario.name,
      displayName: usuario.displayName || usuario.name,
      headshot: headshotRes.body && headshotRes.body.data && headshotRes.body.data[0] && headshotRes.body.data[0].imageUrl || null
    };
    console.log('[SET] Encontrado: @' + info.nome + ' (ID ' + info.id + ')');
    return info;
  } catch (erro) {
    console.error('[SET] Erro na busca Roblox:', erro.message);
    return null;
  }
}

// ============================================================
//  HELPERS DE EQUIPES E SETADORES
// ============================================================
function parseEquipes(texto) {
  const saida = [];
  if (!texto) return saida;
  const partes = texto.split(';');
  for (const parte of partes) {
    const divisao = parte.split(':');
    const nome = divisao[0];
    const eqpsStr = divisao[1] || '';
    if (!nome || !nome.trim()) continue;
    const eqps = eqpsStr.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (eqps.length === 0) eqps.push('Eqp1');
    saida.push({ nome: nome.trim(), eqps: eqps });
  }
  return saida;
}

function equipesParaTexto(arr) {
  if (!arr || !arr.length) return '';
  return arr.map(function (e) {
    return e.nome + ': ' + (e.eqps || []).join(', ');
  }).join('; ');
}

function formatarEquipe(equipe, eqpNome) {
  const idx = (equipe.eqps || []).indexOf(eqpNome);
  const numero = idx >= 0 ? idx + 1 : 1;
  return 'EQP ' + numero + ' "' + equipe.nome + '"';
}

async function buscarSetadores(guild) {
  const mapa = new Map();
  try {
    const todosMembros = await guild.members.fetch();
    for (const [id, membro] of todosMembros) {
      if (membro.user.bot) continue;
      const temCargo = (CFG.set.cargos_setagem || []).some(function (cargoId) {
        return membro.roles.cache.has(cargoId);
      });
      if (temCargo) mapa.set(id, membro);
    }
  } catch (erro) {
    console.error('[SET] Erro ao buscar membros:', erro.message);
  }
  console.log('[SET] Setadores encontrados:', mapa.size);
  return Array.from(mapa.values()).slice(0, 25);
}

function ehAutorizadoSet(member) {
  if (member.id === member.guild.ownerId) return true;
  if (CFG.cargo_confiavel && member.roles.cache.has(CFG.cargo_confiavel)) return true;
  return (CFG.set.cargos_setagem || []).some(function (id) {
    return member.roles.cache.has(id);
  });
}

// ============================================================
//  CLIENT DISCORD
// ============================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const ABAS = {
  PRINCIPAL: 'principal',
  BATE_PONTO: 'bate_ponto',
  PEDIR_SET: 'pedir_set'
};

function podeConfigurar(interacao) {
  if (interacao.user.id === interacao.guild.ownerId) return true;
  if (CFG.cargo_confiavel && interacao.member.roles.cache.has(CFG.cargo_confiavel)) return true;
  return false;
}

function menuDeAbas() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cfg:aba')
      .setPlaceholder('🧭 Navegar entre as seções...')
      .addOptions([
        { label: '🏠 Painel Principal', value: ABAS.PRINCIPAL, emoji: '🏠' },
        { label: '⏱️ Bate-Ponto', value: ABAS.BATE_PONTO, emoji: '⏱️' },
        { label: '📋 Pedir-Set', value: ABAS.PEDIR_SET, emoji: '📋' }
      ])
  );
}

// ============================================================
//  BATE-PONTO — FUNÇÕES (INTACTO)
// ============================================================
async function enviarLogPonto(guild, embed, tipoCanal) {
  const canalId = CFG.ponto[tipoCanal];
  if (!canalId) return;
  const canal = await guild.channels.fetch(canalId).catch(function () { return null; });
  if (canal && canal.isTextBased()) {
    await canal.send({ embeds: [embed] }).catch(function () {});
  }
}

async function iniciarPonto(membro) {
  if (!CFG.ponto.ativo) return { ok: false, msg: '⚠️ Sistema de ponto desativado.' };
  if (DADOS.ponto.sessoes[membro.id]) return { ok: false, msg: '⚠️ Você já tem um ponto aberto.' };
  DADOS.ponto.sessoes[membro.id] = {
    inicio: Date.now(),
    pausado: false,
    tempo_pausa: 0,
    inicio_pausa: null
  };
  salvarDados();
  const embed = new EmbedBuilder()
    .setColor('#3ba55d')
    .setTitle('✅ Ponto Iniciado')
    .setDescription('<@' + membro.id + '> iniciou seu ponto!')
    .setTimestamp()
    .setFooter({ text: CFG.bot.nome + ' System' });
  if (CFG.ponto.banner_inicio) embed.setImage(CFG.ponto.banner_inicio);
  await enviarLogPonto(membro.guild, embed, 'canal_logs_inicio_fim');
  return { ok: true };
}

async function pausarPonto(membro) {
  const sessao = DADOS.ponto.sessoes[membro.id];
  if (!sessao || sessao.pausado) return { ok: false, msg: '⚠️ Ponto não pode ser pausado.' };
  sessao.pausado = true;
  sessao.inicio_pausa = Date.now();
  salvarDados();
  const embed = new EmbedBuilder()
    .setColor('#faa61a')
    .setTitle('⏸️ Ponto Pausado')
    .setDescription('<@' + membro.id + '> pausou seu ponto!')
    .setTimestamp();
  await enviarLogPonto(membro.guild, embed, 'canal_logs_pausas');
  return { ok: true };
}

async function despausarPonto(membro) {
  const sessao = DADOS.ponto.sessoes[membro.id];
  if (!sessao || !sessao.pausado) return { ok: false, msg: '⚠️ Ponto não está pausado.' };
  const tempoPausado = Date.now() - sessao.inicio_pausa;
  sessao.tempo_pausa += tempoPausado;
  sessao.pausado = false;
  sessao.inicio_pausa = null;
  salvarDados();
  const embed = new EmbedBuilder()
    .setColor('#3ba55d')
    .setTitle('▶️ Ponto Despausado')
    .setDescription('<@' + membro.id + '> despausou seu ponto!')
    .setTimestamp();
  await enviarLogPonto(membro.guild, embed, 'canal_logs_pausas');
  return { ok: true };
}

async function encerrarPonto(guild, usuarioId, automatico) {
  if (automatico === undefined) automatico = false;
  const sessao = DADOS.ponto.sessoes[usuarioId];
  if (!sessao) return { ok: false, msg: '⚠️ Sem ponto aberto.' };
  if (sessao.pausado && sessao.inicio_pausa) {
    sessao.tempo_pausa += Date.now() - sessao.inicio_pausa;
  }
  const duracaoTotal = Date.now() - sessao.inicio;
  const tempoTrabalhado = duracaoTotal - sessao.tempo_pausa;
  DADOS.ponto.total_horas[usuarioId] = (DADOS.ponto.total_horas[usuarioId] || 0) + tempoTrabalhado;
  delete DADOS.ponto.sessoes[usuarioId];
  salvarDados();
  const embed = new EmbedBuilder()
    .setColor('#ed4245')
    .setTitle(automatico ? '🔴 Ponto Encerrado Automaticamente' : '🔴 Ponto Encerrado')
    .setDescription('<@' + usuarioId + '> ' + (automatico ? 'foi encerrado por pausa excedida' : 'encerrou seu ponto') + '!')
    .addFields(
      { name: '⏱️ Tempo total', value: '`' + formatarTempo(duracaoTotal) + '`', inline: true },
      { name: '⏸️ Tempo em pausa', value: '`' + formatarTempo(sessao.tempo_pausa) + '`', inline: true },
      { name: '✅ Tempo trabalhado', value: '`' + formatarTempo(tempoTrabalhado) + '`', inline: true },
      { name: '📊 Total acumulado', value: '`' + formatarTempo(DADOS.ponto.total_horas[usuarioId]) + '`', inline: false }
    )
    .setTimestamp();
  if (CFG.ponto.banner_fim) embed.setImage(CFG.ponto.banner_fim);
  await enviarLogPonto(guild, embed, automatico ? 'canal_logs_pausas' : 'canal_logs_inicio_fim');
  return { ok: true };
}

async function cancelarPonto(guild, usuarioId) {
  const sessao = DADOS.ponto.sessoes[usuarioId];
  if (!sessao) return { ok: false, msg: '⚠️ Sem ponto aberto.' };
  delete DADOS.ponto.sessoes[usuarioId];
  salvarDados();
  const embed = new EmbedBuilder()
    .setColor('#ed4245')
    .setTitle('❌ Ponto Cancelado')
    .setDescription('<@' + usuarioId + '> cancelou seu ponto (horas não contadas).')
    .setTimestamp();
  await enviarLogPonto(guild, embed, 'canal_logs_cancelados');
  return { ok: true };
}

setInterval(function () {
  for (const [usuarioId, sessao] of Object.entries(DADOS.ponto.sessoes)) {
    if (sessao.pausado && sessao.inicio_pausa) {
      const limite = CFG.ponto.tempo_pausa_maxima_segundos * 1000;
      if (Date.now() - sessao.inicio_pausa >= limite) {
        const guild = client.guilds.cache.first();
        if (guild) encerrarPonto(guild, usuarioId, true).catch(function () {});
      }
    }
  }
}, 1000);

// ============================================================
//  PAINÉIS DO PONTO (INTACTO)
// ============================================================
function painelPontoPublico() {
  const embed = new EmbedBuilder()
    .setColor('#' + CFG.bot.cor_destaque)
    .setTitle(str(CFG.bot.embed_painel_titulo, '⏱️ Bate-Ponto'))
    .setDescription(str(CFG.bot.embed_painel_descricao, 'Bata seu Ponto aqui.'))
    .setFooter({ text: CFG.bot.nome + ' System' });
  if (CFG.bot.thumbnail_url) embed.setThumbnail(CFG.bot.thumbnail_url);
  if (CFG.ponto.banner_painel_publico) embed.setImage(CFG.ponto.banner_painel_publico);

  const opcoes = (CFG.ponto.menu_opcoes || []).slice(0, 25).map(function (o) {
    return { label: str(o.label, 'Opção').slice(0, 80), value: str(o.valor, 'iniciar') };
  });
  if (opcoes.length === 0) opcoes.push({ label: '▶️ Iniciar Ponto', value: 'iniciar' });

  const menu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ponto:menu')
      .setPlaceholder(str(CFG.ponto.menu_placeholder, 'Selecione uma opção'))
      .addOptions(opcoes)
  );
  return { embeds: [embed], components: [menu] };
}

function painelRanking() {
  const entradas = Object.entries(DADOS.ponto.total_horas || {}).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
  const embed = new EmbedBuilder().setColor('#' + CFG.bot.cor_destaque).setTitle('🏆 Ranking — Mais Tempo').setTimestamp();
  if (entradas.length === 0) {
    embed.addFields({ name: '📭 Sem dados ainda', value: 'Ninguém bateu ponto ainda!', inline: false });
  } else {
    entradas.forEach(function (entrada, idx) {
      const userId = entrada[0];
      const tempoMs = entrada[1];
      const posicao = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : (idx + 1) + '°';
      const equipe = (DADOS.set.setados && DADOS.set.setados[userId]) || '—';
      embed.addFields({ name: posicao + ' Usuário', value: '<@' + userId + '>\n`' + formatarTempo(tempoMs) + '`\n🏢 ' + equipe, inline: true });
    });
  }
  return { embeds: [embed], ephemeral: true };
}

const paineisAtivos = {};

function painelPontoAtivo(usuarioId, avatarURL, username) {
  const sessao = DADOS.ponto.sessoes[usuarioId];
  if (!sessao) return null;
  const tempoDecorrido = sessao.pausado
    ? (sessao.inicio_pausa - sessao.inicio) - sessao.tempo_pausa
    : (Date.now() - sessao.inicio) - sessao.tempo_pausa;

  const embed = new EmbedBuilder()
    .setColor(sessao.pausado ? '#faa61a' : '#3ba55d')
    .setTitle('Ponto - ' + (username || 'Usuário'))
    .setDescription('Informações do ponto')
    .addFields(
      { name: 'Membro', value: '<@' + usuarioId + '>', inline: true },
      { name: 'Início do Ponto', value: '<t:' + unix(sessao.inicio) + ':R>', inline: true },
      { name: '⏱️ Tempo trabalhado', value: '`' + formatarTempo(tempoDecorrido) + '`', inline: false },
      { name: 'Pausado?', value: sessao.pausado ? 'Sim' : 'Não', inline: true }
    )
    .setFooter({ text: 'Use os botões abaixo para gerenciar seu ponto' });
  if (avatarURL) embed.setThumbnail(avatarURL);
  if (sessao.tempo_pausa > 0) {
    embed.addFields({ name: '⏸️ Tempo em pausa', value: '`' + formatarTempo(sessao.tempo_pausa) + '`', inline: true });
  }

  const botoes = new ActionRowBuilder();
  if (sessao.pausado) {
    botoes.addComponents(
      new ButtonBuilder().setCustomId('ponto:despausar').setLabel('▶️ Despausar').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ponto:encerrar').setLabel('✅ Finalizar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ponto:cancelar').setLabel('❌ Cancelar').setStyle(ButtonStyle.Danger)
    );
  } else {
    botoes.addComponents(
      new ButtonBuilder().setCustomId('ponto:pausar').setLabel('⏸️ Pausar').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ponto:encerrar').setLabel('✅ Finalizar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ponto:cancelar').setLabel('❌ Cancelar').setStyle(ButtonStyle.Danger)
    );
  }
  return { embeds: [embed], components: [botoes], ephemeral: true };
}

setInterval(async function () {
  for (const [usuarioId, info] of Object.entries(paineisAtivos)) {
    try {
      const novoPainel = painelPontoAtivo(usuarioId, info.avatarURL, info.username);
      if (!novoPainel) { delete paineisAtivos[usuarioId]; continue; }
      const canal = await client.channels.fetch(info.canalId).catch(function () { return null; });
      if (!canal) continue;
      const mensagem = await canal.messages.fetch(info.msgId).catch(function () { return null; });
      if (!mensagem) { delete paineisAtivos[usuarioId]; continue; }
      await mensagem.edit(novoPainel).catch(function () {});
    } catch (erro) {
      delete paineisAtivos[usuarioId];
    }
  }
}, 60000);

// ============================================================
//  SISTEMA DE SET
// ============================================================
const pedidosTemp = {};

function gerarIdSet() {
  return Math.random().toString(36).slice(2, 8);
}

function embedSolicitacaoSet(sol) {
  const horas = CFG.set.expiracao_horas || 12;
  const cores = { pendente: '#3b82f6', setado: '#3ba55d', recusado: '#ed4245', expirado: '#747f8d' };
  const embed = new EmbedBuilder()
    .setColor(cores[sol.status] || '#3b82f6')
    .setTitle('Solicitação de SET')
    .addFields(
      { name: 'Solicitante:', value: '<@' + sol.solicitante_id + '>', inline: false },
      { name: 'Nick do Roblox:', value: str(sol.roblox && sol.roblox.nome, '—'), inline: false },
      { name: 'Equipe:', value: str(sol.equipe_texto, '—'), inline: false },
      { name: 'Setador solicitado:', value: '<@' + sol.setador_id + '>', inline: false }
    )
    .setFooter({ text: CFG.bot.nome + ' • ID: ' + sol.id })
    .setTimestamp(sol.criado_em);
  if (sol.roblox && sol.roblox.headshot) embed.setThumbnail(sol.roblox.headshot);

  if (sol.status === 'pendente') {
    embed.setDescription('Aguarde. Um membro autorizado vai analisar sua solicitação.\nExpira em ' + horas + ' horas — <t:' + unix(sol.expira_em) + ':R>');
  } else if (sol.status === 'setado') {
    embed.setDescription('✅ Setado por <@' + sol.respondido_por + '>.');
  } else if (sol.status === 'recusado') {
    embed.setDescription('❌ Recusado por <@' + sol.respondido_por + '>.');
  } else {
    embed.setDescription('⏰ Expirado.');
  }
  return embed;
}

function botoesLogSet(sol) {
  if (sol.status !== 'pendente') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setlog:setado:' + sol.id).setLabel('Setado').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setlog:recusar:' + sol.id).setLabel('Recusar').setStyle(ButtonStyle.Danger)
  )];
}

async function criarSolicitacaoSet(guild, solicitanteId, setadorId, equipeTexto, roblox) {
  const id = gerarIdSet();
  const horas = CFG.set.expiracao_horas || 12;
  const sol = {
    id: id,
    solicitante_id: solicitanteId,
    setador_id: setadorId,
    equipe_texto: equipeTexto,
    roblox: roblox,
    criado_em: Date.now(),
    expira_em: Date.now() + horas * 3600000,
    status: 'pendente',
    respondido_por: null,
    canal_logs_id: null,
    msg_logs_id: null
  };
  DADOS.set.solicitacoes[id] = sol;
  salvarDados();
  console.log('[SET] Solicitação criada: ' + id);

  if (CFG.set.canal_logs) {
    const canal = await guild.channels.fetch(CFG.set.canal_logs).catch(function () { return null; });
    if (canal && canal.isTextBased()) {
      const msg = await canal.send({ embeds: [embedSolicitacaoSet(sol)], components: botoesLogSet(sol) }).catch(function (erro) {
        console.error('[SET] Erro ao enviar log:', erro.message);
        return null;
      });
      if (msg) {
        sol.canal_logs_id = canal.id;
        sol.msg_logs_id = msg.id;
        salvarDados();
      }
    }
  }

  try {
    const setador = await guild.members.fetch(setadorId).catch(function () { return null; });
    if (setador) {
      const dmEmbed = new EmbedBuilder()
        .setColor('#' + CFG.bot.cor_destaque)
        .setTitle('📋 Novo Pedido de SET para você!')
        .setDescription('<@' + solicitanteId + '> pediu para ser setado por você.')
        .addFields(
          { name: '🎮 Nick Roblox', value: '@' + roblox.nome, inline: true },
          { name: '🏢 Equipe', value: equipeTexto, inline: true },
          { name: '⏰ Expira em', value: '<t:' + unix(sol.expira_em) + ':R>', inline: true }
        )
        .setFooter({ text: 'Pedido #' + id });
      if (roblox.headshot) dmEmbed.setThumbnail(roblox.headshot);
      await setador.send({ embeds: [dmEmbed] }).catch(function () {});
    }
  } catch (erro) {
    console.error('[SET] Erro DM:', erro.message);
  }
  return sol;
}

async function atualizarStatusSet(guild, id, status, userId) {
  const sol = DADOS.set.solicitacoes && DADOS.set.solicitacoes[id];
  if (!sol) return;
  sol.status = status;
  sol.respondido_por = userId;
  salvarDados();
  // NOVO: quando é setado, guarda a equipe do usuário pra mostrar no ranking
  if (status === 'setado' && sol.equipe_texto && sol.solicitante_id) {
    if (!DADOS.set.setados) DADOS.set.setados = {};
    DADOS.set.setados[sol.solicitante_id] = sol.equipe_texto;
    salvarDados();
    console.log('[SET] Equipe guardada para <@' + sol.solicitante_id + '>: ' + sol.equipe_texto);
  }
  if (sol.canal_logs_id && sol.msg_logs_id) {
    try {
      const canal = await guild.channels.fetch(sol.canal_logs_id).catch(function () { return null; });
      if (!canal) return;
      const msg = await canal.messages.fetch(sol.msg_logs_id).catch(function () { return null; });
      if (msg) await msg.edit({ embeds: [embedSolicitacaoSet(sol)], components: botoesLogSet(sol) }).catch(function () {});
    } catch (erro) {}
  }
}

setInterval(function () {
  const agora = Date.now();
  for (const [id, sol] of Object.entries(DADOS.set.solicitacoes || {})) {
    if (sol.status === 'pendente' && sol.expira_em <= agora) {
      const guild = client.guilds.cache.first();
      if (guild) atualizarStatusSet(guild, id, 'expirado', null).catch(function () {});
    }
  }
}, 60000);

function painelSetPublico() {
  const embed = new EmbedBuilder()
    .setColor('#' + CFG.bot.cor_destaque)
    .setTitle(str(CFG.set.embed_titulo, '📋 Solicitar SET'))
    .setDescription(str(CFG.set.embed_descricao, 'Clique no botão abaixo para solicitar uma setagem.'))
    .setFooter({ text: CFG.bot.nome + ' System' });
  if (CFG.set.banner) embed.setImage(CFG.set.banner);
  const botao = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('set:pedir')
      .setLabel(str(CFG.set.botao_label, '📋 Pedir Set').slice(0, 80))
      .setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [botao] };
}

async function montarPainelPedido(guild, uid) {
  const temp = pedidosTemp[uid];
  if (!temp) return null;
  const roblox = temp.roblox;
  const equipeIdx = temp.equipeIdx;
  const eqp = temp.eqp;
  const setadorId = temp.setadorId;
  const equipes = CFG.set.equipes || [];
  const componentes = [];

  const embed = new EmbedBuilder()
    .setColor('#' + CFG.bot.cor_destaque)
    .setTitle('🎮 ' + roblox.displayName)
    .setDescription('Confira o personagem e escolha a equipe e o setador.')
    .addFields(
      { name: '👤 Nick', value: '@' + roblox.nome, inline: true },
      { name: '🆔 ID', value: '`' + roblox.id + '`', inline: true },
      { name: '🏢 Equipe', value: (equipeIdx != null && eqp) ? formatarEquipe(equipes[equipeIdx], eqp) : '`Selecione abaixo`', inline: true },
      { name: '🎯 Setador', value: setadorId ? '<@' + setadorId + '>' : '`Selecione abaixo`', inline: true }
    )
    .setFooter({ text: CFG.bot.nome + ' System' });
  if (roblox.headshot) embed.setThumbnail(roblox.headshot);

  if (equipes.length > 1) {
    componentes.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('set:sel_equipe')
        .setPlaceholder('🏢 Escolha a equipe...')
        .addOptions(equipes.map(function (eq, i) {
          return { label: eq.nome, value: String(i), default: equipeIdx === i };
        }))
    ));
  }

  if (equipeIdx != null && equipes[equipeIdx] && (equipes[equipeIdx].eqps || []).length > 1) {
    componentes.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('set:sel_eqp')
        .setPlaceholder('🔢 Escolha a EQP...')
        .addOptions(equipes[equipeIdx].eqps.map(function (eq, i) {
          return { label: 'EQP ' + (i + 1), value: eq, default: eqp === eq };
        }))
    ));
  }

  const setadores = await buscarSetadores(guild);
  if (setadores.length === 0) {
    embed.addFields({ name: '⚠️ Aviso', value: 'Nenhum setador disponível. Peça a um gestor para configurar os Cargos de Setagem.', inline: false });
  } else {
    componentes.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('set:sel_setador')
        .setPlaceholder('🎯 Escolha quem vai setar...')
        .addOptions(setadores.map(function (m) {
          return { label: m.displayName || m.user.username, value: m.id, default: setadorId === m.id };
        }))
    ));
  }

  const pronto = !!setadorId && (equipes.length === 0 || (equipeIdx != null && !!eqp));
  componentes.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('set:enviar')
      .setLabel('✅ Enviar Solicitação')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!pronto)
  ));

  return { embeds: [embed], components: componentes, ephemeral: true };
}

// ============================================================
//  PAINÉIS DE CONFIGURAÇÃO
// ============================================================
function painelPrincipal(guild, ping, usuarioId) {
  const cargoTexto = CFG.cargo_confiavel ? '<@&' + CFG.cargo_confiavel + '>' : '`Nenhum cargo selecionado`';
  const embed = new EmbedBuilder()
    .setColor('#' + CFG.bot.cor_destaque)
    .setTitle('👋 Olá, <@' + usuarioId + '>!')
    .setDescription('Aqui você pode configurar o **' + CFG.bot.nome + '**.')
    .addFields(
      { name: '📊 Status do Sistema', value: '🟢 `Sistema Ativo`\n📦 Versão: `' + CFG.bot.versao + '`\n🔌 Ping: `' + ping + ' ms`', inline: false },
      { name: '═'.repeat(18), value: ' ', inline: false },
      { name: '📝 Descrição do Bot', value: '```' + CFG.descricao_bot + '```', inline: false },
      { name: '═'.repeat(18), value: ' ', inline: false },
      { name: '🌐 SOUSTICE Web Site', value: 'Acesse nosso painel clicando no botão abaixo.', inline: false },
      { name: '🔒 Cargo de Confiança', value: cargoTexto + '\n*Quem ocupar este cargo poderá gerenciar as configurações.*', inline: false },
      { name: '═'.repeat(18), value: ' ', inline: false },
      { name: '💡 Curiosidade', value: 'O **' + CFG.bot.nome + '** foi criado para facilitar o gerenciamento de equipes e controle de presença!', inline: false }
    )
    .setFooter({ text: CFG.bot.nome + ' System • Feito para organizar 🤝' })
    .setTimestamp();

  const linhaSite = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🔗 Acessar SITE').setStyle(ButtonStyle.Link).setURL(CFG.bot.url_site)
  );
  const linhaCargo = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cfg:sel_cargo')
      .setPlaceholder('📌 Escolha o cargo de confiança...')
      .addOptions(
        ...guild.roles.cache
          .filter(function (r) { return !r.managed && r.id !== guild.id && r.name !== '@everyone'; })
          .sort(function (a, b) { return b.position - a.position; })
          .first(25)
          .map(function (r) { return { label: r.name, value: r.id, default: CFG.cargo_confiavel === r.id }; })
      )
  );
  return { embeds: [embed], components: [linhaSite, linhaCargo, menuDeAbas()], ephemeral: true };
}

function painelBatePontoConfig() {
  const embed = new EmbedBuilder()
    .setColor('#' + CFG.bot.cor_destaque)
    .setTitle('⏱️ Painel de Bate-Ponto')
    .addFields(
      { name: '📋 Canais Configurados', value: '═'.repeat(14), inline: false },
      { name: 'Painel Público *', value: CFG.ponto.canal_painel_publico ? '<#' + CFG.ponto.canal_painel_publico + '>' : '❌ Obrigatório', inline: true },
      { name: 'Início/Fim', value: CFG.ponto.canal_logs_inicio_fim ? '<#' + CFG.ponto.canal_logs_inicio_fim + '>' : '❌ Opcional', inline: true },
      { name: 'Pausas', value: CFG.ponto.canal_logs_pausas ? '<#' + CFG.ponto.canal_logs_pausas + '>' : '❌ Opcional', inline: true },
      { name: 'Cancelados', value: CFG.ponto.canal_logs_cancelados ? '<#' + CFG.ponto.canal_logs_cancelados + '>' : '❌ Opcional', inline: true },
      { name: '═'.repeat(18), value: ' ', inline: false },
      { name: '⏱️ Tempo de Pausa Máx.', value: '`' + CFG.ponto.tempo_pausa_maxima_segundos + ' segundos` (' + Math.floor(CFG.ponto.tempo_pausa_maxima_segundos / 60) + ' min)', inline: false },
      { name: '✏️ Embed do Painel', value: '**Título:** ' + CFG.bot.embed_painel_titulo + '\n**Thumbnail:** ' + (CFG.bot.thumbnail_url ? '✅ Definida' : '❌ Não definida'), inline: false },
      { name: '📋 Menu do Painel', value: 'Placeholder: `' + CFG.ponto.menu_placeholder + '`\nOpções: ' + (CFG.ponto.menu_opcoes || []).map(function (o) { return o.label; }).join(' | '), inline: false },
      { name: '🖼️ Banners', value: 'Painel: ' + (CFG.ponto.banner_painel_publico ? '✅' : '❌ Opcional') + '\nInício: ' + (CFG.ponto.banner_inicio ? '✅' : '❌ Opcional') + '\nFim: ' + (CFG.ponto.banner_fim ? '✅' : '❌ Opcional'), inline: false },
      { name: '═'.repeat(18), value: ' ', inline: false },
      { name: '📌 Observações', value: '*Apenas o Painel Público é obrigatório.', inline: false }
    )
    .setFooter({ text: CFG.bot.nome + ' System' })
    .setTimestamp();

  const l1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bp:canal_painel_publico').setLabel('📌 Painel Público *').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bp:canal_inicio_fim').setLabel('📌 Início/Fim').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bp:canal_pausas').setLabel('⏸️ Pausas').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bp:canal_cancelados').setLabel('❌ Cancelados').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bp:tempo_pausa').setLabel('⏱️ Tempo Pausa').setStyle(ButtonStyle.Secondary)
  );
  const l2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bp:alterar_titulo').setLabel('✏️ Título').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bp:alterar_descricao').setLabel('📝 Descrição').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bp:thumbnail').setLabel('🖼️ Thumbnail').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bp:menu_opcoes').setLabel('📋 Texto do Menu').setStyle(ButtonStyle.Primary)
  );
  const l3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bp:banner_painel').setLabel('🖼️ Banner Painel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bp:banner_inicio').setLabel('🖼️ Banner Início').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bp:banner_fim').setLabel('🖼️ Banner Fim').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bp:enviar_painel').setLabel('📤 Enviar Painel').setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [l1, l2, l3, menuDeAbas()], ephemeral: true };
}

function painelSetConfig() {
  const cargosTexto = (CFG.set.cargos_setagem || []).length
    ? (CFG.set.cargos_setagem.map(function (id) { return '<@&' + id + '>'; }).join(', '))
    : '❌ Nenhum definido';

  const embed = new EmbedBuilder()
    .setColor('#' + CFG.bot.cor_destaque)
    .setTitle('📋 Config — Pedir Set')
    .addFields(
      { name: '🎯 Cargos de Setagem', value: cargosTexto, inline: false },
      { name: '🏢 Times / EQPs', value: equipesParaTexto(CFG.set.equipes) || '❌ Nenhum', inline: false },
      { name: '📄 Canal de Logs', value: CFG.set.canal_logs ? '<#' + CFG.set.canal_logs + '>' : '❌ Não definido', inline: true },
      { name: '📢 Canal do Painel', value: CFG.set.canal_painel ? '<#' + CFG.set.canal_painel + '>' : '❌ Não definido', inline: true },
      { name: '⏰ Expiração', value: (CFG.set.expiracao_horas || 12) + ' horas', inline: true },
      { name: '✏️ Painel Público', value: '**Título:** ' + CFG.set.embed_titulo + '\n**Botão:** ' + CFG.set.botao_label + '\n**Banner:** ' + (CFG.set.banner ? '✅ Definido' : '❌ Não definido'), inline: false }
    )
    .setFooter({ text: CFG.bot.nome + ' System' })
    .setTimestamp();

  const l1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sc:cargos').setLabel('🎯 Cargos Setagem').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sc:times').setLabel('🏢 Times/EQPs').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sc:canal_logs').setLabel('📄 Canal Logs').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sc:canal_painel').setLabel('📢 Canal Painel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sc:expiracao').setLabel('⏰ Expiração').setStyle(ButtonStyle.Secondary)
  );
  const l2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sc:titulo').setLabel('✏️ Título').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sc:descricao').setLabel('📝 Descrição').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sc:banner').setLabel('🖼️ Banner').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sc:botao').setLabel('🔘 Texto Botão').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sc:enviar_painel').setLabel('📤 Enviar Painel').setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [l1, l2, menuDeAbas()], ephemeral: true };
}

async function atualizarPainelConfig(interacao, painelFn, textoSucesso) {
  salvarConfig();
  console.log('💾 ' + textoSucesso);
  try {
    await interacao.update(painelFn());
  } catch (erro) {
    console.error('⚠️ Update falhou, enviando confirmação:', erro.message);
    try {
      await interacao.reply({ content: '✅ ' + textoSucesso, ephemeral: true });
    } catch (e2) {
      try { await interacao.followUp({ content: '✅ ' + textoSucesso, ephemeral: true }); } catch (e3) {}
    }
  }
}

const comandos = [new SlashCommandBuilder().setName('config').setDescription('Painel de configuração').toJSON()];

client.once('ready', async function () {
  console.log('✅ Conectado como ' + client.user.tag + ' — v' + CFG.bot.versao);
  console.log('[SET] Cargos de setagem: ' + (CFG.set.cargos_setagem || []).length + ' | Canal logs: ' + (CFG.set.canal_logs || 'Nenhum') + ' | Canal painel: ' + (CFG.set.canal_painel || 'Nenhum'));
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const rota = Routes.applicationCommands(CLIENT_ID); // global → funciona em TODOS os servidores
    await rest.put(rota, { body: comandos });
    console.log('✅ Comando /config registrado (global)!');
  } catch (erro) {
    console.error('❌ Erro no registro de comandos:', erro.message);
  }
  client.user.setActivity('SOUSTICE System', { type: 3 });
});

// ============================================================
//  HANDLER PRINCIPAL
// ============================================================
client.on('interactionCreate', async function (interacao) {
  const i = interacao;
  try {
    // ---------- COMANDO /CONFIG ----------
    if (i.isChatInputCommand()) {
      if (i.commandName === 'config') {
        if (!podeConfigurar(i)) {
          return i.reply({ content: '❌ Sem permissão! Apenas o dono ou cargo de confiança.', ephemeral: true });
        }
        await i.reply(painelPrincipal(i.guild, client.ws.ping, i.user.id));
      }
      return;
    }

    // ---------- MENU PÚBLICO DO PONTO ----------
    if (i.isStringSelectMenu() && i.customId === 'ponto:menu') {
      const opcao = i.values[0];
      if (opcao === 'iniciar') {
        const res = await iniciarPonto(i.member);
        if (!res.ok) return i.reply({ content: res.msg, ephemeral: true });
        const avatarURL = i.user.displayAvatarURL({ size: 128, dynamic: true });
        const resposta = await i.reply({ ...painelPontoAtivo(i.user.id, avatarURL, i.user.username), fetchReply: true });
        paineisAtivos[i.user.id] = { canalId: i.channel.id, msgId: resposta.id, avatarURL: avatarURL, username: i.user.username };
      } else if (opcao === 'ranking') {
        await i.reply(painelRanking());
      } else {
        await i.reply({ content: '⚠️ Opção inválida.', ephemeral: true });
      }
      return;
    }

    // ---------- BOTÕES DO PONTO ATIVO ----------
    if (i.isButton() && ['ponto:pausar', 'ponto:despausar', 'ponto:encerrar', 'ponto:cancelar'].indexOf(i.customId) >= 0) {
      const info = paineisAtivos[i.user.id] || {};
      if (i.customId === 'ponto:pausar') {
        const res = await pausarPonto(i.member);
        if (!res.ok) return i.reply({ content: res.msg, ephemeral: true });
        await i.update(painelPontoAtivo(i.user.id, info.avatarURL, info.username));
      } else if (i.customId === 'ponto:despausar') {
        const res = await despausarPonto(i.member);
        if (!res.ok) return i.reply({ content: res.msg, ephemeral: true });
        await i.update(painelPontoAtivo(i.user.id, info.avatarURL, info.username));
      } else if (i.customId === 'ponto:encerrar') {
        const res = await encerrarPonto(i.guild, i.user.id);
        if (!res.ok) return i.reply({ content: res.msg, ephemeral: true });
        delete paineisAtivos[i.user.id];
        await i.update({ content: '✅ Ponto finalizado! Horas contabilizadas.', embeds: [], components: [] });
      } else {
        const res = await cancelarPonto(i.guild, i.user.id);
        if (!res.ok) return i.reply({ content: res.msg, ephemeral: true });
        delete paineisAtivos[i.user.id];
        await i.update({ content: '❌ Ponto cancelado! Horas não contabilizadas.', embeds: [], components: [] });
      }
      return;
    }

    // ---------- NAVEGAÇÃO DE ABAS ----------
    if (i.isStringSelectMenu() && i.customId === 'cfg:aba') {
      if (!podeConfigurar(i)) return;
      const alvo = i.values[0];
      if (alvo === ABAS.PRINCIPAL) {
        await i.update(painelPrincipal(i.guild, client.ws.ping, i.user.id));
      } else if (alvo === ABAS.BATE_PONTO) {
        await i.update(painelBatePontoConfig());
      } else {
        await i.update(painelSetConfig());
      }
      return;
    }

    // ---------- SELECIONAR CARGO DE CONFIANÇA ----------
    if (i.isStringSelectMenu() && i.customId === 'cfg:sel_cargo') {
      if (i.user.id !== i.guild.ownerId) {
        return i.reply({ content: '❌ Apenas o dono do servidor pode alterar!', ephemeral: true });
      }
      CFG.cargo_confiavel = i.values[0];
      salvarConfig();
      await i.update(painelPrincipal(i.guild, client.ws.ping, i.user.id));
      return;
    }

    // ---------- BOTÕES DE CONFIG DO BATE-PONTO (bp:) ----------
    if (i.isButton() && i.customId.indexOf('bp:') === 0) {
      if (!podeConfigurar(i)) return i.reply({ content: '❌ Sem permissão!', ephemeral: true });
      const acao = i.customId.slice(3);

      if (acao === 'enviar_painel') {
        if (!CFG.ponto.canal_painel_publico) {
          return i.reply({ content: '⚠️ Defina o Painel Público primeiro! É obrigatório.', ephemeral: true });
        }
        const canal = await i.guild.channels.fetch(CFG.ponto.canal_painel_publico).catch(function () { return null; });
        if (!canal) return i.reply({ content: '⚠️ Canal inválido.', ephemeral: true });
        await canal.send(painelPontoPublico());
        return i.reply({ content: '✅ Painel enviado com sucesso!', ephemeral: true });
      }

      if (acao === 'alterar_titulo') {
        const valorAtual = str(CFG.bot.embed_painel_titulo, '').replace(/\n/g, ' ').slice(0, 250);
        const modal = new ModalBuilder().setCustomId('modal:bp_titulo').setTitle('✏️ Alterar Título')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('Novo Título').setStyle(TextInputStyle.Short).setValue(valorAtual).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }

      if (acao === 'alterar_descricao') {
        const valorAtual = str(CFG.bot.embed_painel_descricao, '').slice(0, 3900);
        const modal = new ModalBuilder().setCustomId('modal:bp_descricao').setTitle('📝 Alterar Descrição')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('Nova Descrição').setStyle(TextInputStyle.Paragraph).setValue(valorAtual).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }

      if (acao === 'thumbnail') {
        const modal = new ModalBuilder().setCustomId('modal:bp_thumbnail').setTitle('🖼️ Thumbnail do Painel')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('URL da Imagem (vazio remove)').setStyle(TextInputStyle.Short).setValue(str(CFG.bot.thumbnail_url, '')).setRequired(false)));
        return abrirModalSeguro(i, modal);
      }

      if (acao === 'menu_opcoes') {
        const placeholder = str(CFG.ponto.menu_placeholder, 'Selecione uma opção');
        const labels = (CFG.ponto.menu_opcoes || []).map(function (o) { return str(o.label, ''); }).join('\n');
        const modal = new ModalBuilder().setCustomId('modal:bp_menu').setTitle('📋 Texto do Menu')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('placeholder').setLabel('Placeholder do menu').setStyle(TextInputStyle.Short).setValue(placeholder).setRequired(true)),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('opcoes').setLabel('Labels das opções (uma por linha)').setStyle(TextInputStyle.Paragraph).setValue(labels).setRequired(true))
          );
        return abrirModalSeguro(i, modal);
      }

      const ehCanal = acao.indexOf('canal_') === 0;
      const ehBanner = acao.indexOf('banner_') === 0;
      if (ehCanal || ehBanner || acao === 'tempo_pausa') {
        const etiqueta = acao === 'tempo_pausa' ? 'Segundos (60=1min)' : (ehCanal ? 'ID do Canal' : 'URL da Imagem');
        const modal = new ModalBuilder().setCustomId('modal:bp_' + acao).setTitle(etiqueta)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel(etiqueta).setStyle(TextInputStyle.Short).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }

      return i.reply({ content: '⚠️ Ação não reconhecida.', ephemeral: true }).catch(function () {});
    }

    // ---------- BOTÕES DE CONFIG DO SET (sc:) ----------
    if (i.isButton() && i.customId.indexOf('sc:') === 0) {
      if (!podeConfigurar(i)) return i.reply({ content: '❌ Sem permissão!', ephemeral: true });
      const acao = i.customId.slice(3);

      if (acao === 'enviar_painel') {
        if (!CFG.set.canal_painel) {
          return i.reply({ content: '⚠️ Defina o Canal do Painel de SET primeiro! (botão 📢 Canal Painel)', ephemeral: true });
        }
        const canal = await i.guild.channels.fetch(CFG.set.canal_painel).catch(function () { return null; });
        if (!canal) return i.reply({ content: '⚠️ Canal inválido. Verifique o ID.', ephemeral: true });
        await canal.send(painelSetPublico());
        return i.reply({ content: '✅ Painel de SET enviado com sucesso!', ephemeral: true });
      }

      if (acao === 'cargos') {
        const atual = (CFG.set.cargos_setagem || []).join(', ');
        const modal = new ModalBuilder().setCustomId('modal:sc_cargos').setTitle('🎯 Cargos de Setagem')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('IDs dos cargos (separados por vírgula)').setStyle(TextInputStyle.Short).setValue(atual).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }
      if (acao === 'times') {
        const atual = equipesParaTexto(CFG.set.equipes);
        const modal = new ModalBuilder().setCustomId('modal:sc_times').setTitle('🏢 Times e EQPs')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('Formato: NOME: Eqp1, Eqp2; NOME2: Eqp1').setStyle(TextInputStyle.Paragraph).setValue(atual).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }
      if (acao === 'canal_logs') {
        const modal = new ModalBuilder().setCustomId('modal:sc_canal_logs').setTitle('📄 Canal de Logs')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('ID do Canal').setStyle(TextInputStyle.Short).setValue(str(CFG.set.canal_logs, '')).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }
      if (acao === 'canal_painel') {
        const modal = new ModalBuilder().setCustomId('modal:sc_canal_painel').setTitle('📢 Canal do Painel')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('ID do Canal').setStyle(TextInputStyle.Short).setValue(str(CFG.set.canal_painel, '')).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }
      if (acao === 'expiracao') {
        const modal = new ModalBuilder().setCustomId('modal:sc_expiracao').setTitle('⏰ Expiração')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('Número de horas').setStyle(TextInputStyle.Short).setValue(str(CFG.set.expiracao_horas, '12')).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }
      if (acao === 'titulo') {
        const modal = new ModalBuilder().setCustomId('modal:sc_titulo').setTitle('✏️ Título do Painel')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('Título').setStyle(TextInputStyle.Short).setValue(str(CFG.set.embed_titulo, '')).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }
      if (acao === 'descricao') {
        const modal = new ModalBuilder().setCustomId('modal:sc_descricao').setTitle('📝 Descrição do Painel')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('Descrição').setStyle(TextInputStyle.Paragraph).setValue(str(CFG.set.embed_descricao, '')).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }
      if (acao === 'banner') {
        const modal = new ModalBuilder().setCustomId('modal:sc_banner').setTitle('🖼️ Banner do Painel')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('URL da Imagem (vazio remove)').setStyle(TextInputStyle.Short).setValue(str(CFG.set.banner, '')).setRequired(false)));
        return abrirModalSeguro(i, modal);
      }
      if (acao === 'botao') {
        const modal = new ModalBuilder().setCustomId('modal:sc_botao').setTitle('🔘 Texto do Botão')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('valor').setLabel('Texto do botão "Pedir Set"').setStyle(TextInputStyle.Short).setValue(str(CFG.set.botao_label, '📋 Pedir Set')).setRequired(true)));
        return abrirModalSeguro(i, modal);
      }

      return i.reply({ content: '⚠️ Ação não reconhecida.', ephemeral: true }).catch(function () {});
    }

    // ---------- BOTÃO PEDIR SET (painel público) ----------
    if (i.isButton() && i.customId === 'set:pedir') {
      console.log('[SET] Botão Pedir Set clicado por', i.user.tag);
      if (!CFG.set.ativo) return i.reply({ content: '⚠️ Sistema de SET desativado.', ephemeral: true });
      if (!CFG.set.canal_logs) return i.reply({ content: '⚠️ SET não configurado: peça a um gestor para definir o Canal de Logs em /config → Pedir-Set.', ephemeral: true });
      if (!(CFG.set.cargos_setagem || []).length) return i.reply({ content: '⚠️ SET não configurado: peça a um gestor para definir os Cargos de Setagem em /config → Pedir-Set.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId('modal:set_nick').setTitle('🎮 Pedir Set')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('nick').setLabel('Seu nick do Roblox').setStyle(TextInputStyle.Short).setPlaceholder('Ex: Alvaro_Arthur07').setRequired(true)));
      return abrirModalSeguro(i, modal);
    }

    // ---------- MENUS DO PEDIDO DE SET ----------
    if (i.isStringSelectMenu() && ['set:sel_equipe', 'set:sel_eqp', 'set:sel_setador'].indexOf(i.customId) >= 0) {
      const temp = pedidosTemp[i.user.id];
      if (!temp) return i.reply({ content: '⚠️ Pedido expirado. Clique em "Pedir Set" novamente.', ephemeral: true });
      if (i.customId === 'set:sel_equipe') {
        temp.equipeIdx = parseInt(i.values[0], 10);
        const eqps = (CFG.set.equipes[temp.equipeIdx] && CFG.set.equipes[temp.equipeIdx].eqps) || [];
        temp.eqp = eqps.length === 1 ? eqps[0] : null;
      } else if (i.customId === 'set:sel_eqp') {
        temp.eqp = i.values[0];
      } else {
        temp.setadorId = i.values[0];
        console.log('[SET] Setador escolhido:', temp.setadorId);
      }
      await i.update(await montarPainelPedido(i.guild, i.user.id));
      return;
    }

    // ---------- ENVIAR PEDIDO DE SET ----------
    if (i.isButton() && i.customId === 'set:enviar') {
      const temp = pedidosTemp[i.user.id];
      if (!temp) return i.reply({ content: '⚠️ Pedido expirado. Tente novamente.', ephemeral: true });
      if (!temp.setadorId) return i.reply({ content: '⚠️ Selecione um setador!', ephemeral: true });
      const equipes = CFG.set.equipes || [];
      let eqTxt = '—';
      if (equipes.length > 0) {
        if (temp.equipeIdx == null || !temp.eqp) return i.reply({ content: '⚠️ Selecione a equipe e a EQP!', ephemeral: true });
        eqTxt = formatarEquipe(equipes[temp.equipeIdx], temp.eqp);
      }
      await criarSolicitacaoSet(i.guild, i.user.id, temp.setadorId, eqTxt, temp.roblox);
      delete pedidosTemp[i.user.id];
      await i.update({ content: '✅ Solicitação enviada! O setador foi notificado na DM.', embeds: [], components: [] });
      return;
    }

    // ---------- BOTÕES DO LOG DE SET (Setado / Recusar) ----------
    if (i.isButton() && i.customId.indexOf('setlog:') === 0) {
      const partes = i.customId.split(':');
      const acao = partes[1];
      const id = partes[2];
      const sol = DADOS.set.solicitacoes && DADOS.set.solicitacoes[id];
      if (!sol) return i.reply({ content: '⚠️ Pedido não encontrado.', ephemeral: true });
      if (sol.status !== 'pendente') return i.reply({ content: '⚠️ Este pedido já foi finalizado.', ephemeral: true });
      if (!ehAutorizadoSet(i.member)) return i.reply({ content: '❌ Apenas membros autorizados podem marcar.', ephemeral: true });
      await atualizarStatusSet(i.guild, id, acao === 'setado' ? 'setado' : 'recusado', i.user.id);
      return i.reply({ content: acao === 'setado' ? '✅ Marcado como Setado!' : '❌ Marcado como Recusado.', ephemeral: true });
    }

    // ---------- MODAIS ----------
    if (i.isModalSubmit()) {
      const cid = i.customId;
      const pegarValor = function () { return str(i.fields.getTextInputValue('valor'), '').trim(); };

      if (cid === 'modal:bp_titulo') {
        CFG.bot.embed_painel_titulo = pegarValor().slice(0, 256);
        return atualizarPainelConfig(i, painelBatePontoConfig, 'Título do painel de ponto atualizado!');
      }
      if (cid === 'modal:bp_descricao') {
        CFG.bot.embed_painel_descricao = pegarValor().slice(0, 4000);
        return atualizarPainelConfig(i, painelBatePontoConfig, 'Descrição do painel de ponto atualizada!');
      }
      if (cid === 'modal:bp_thumbnail') {
        CFG.bot.thumbnail_url = pegarValor();
        return atualizarPainelConfig(i, painelBatePontoConfig, 'Thumbnail atualizada!');
      }
      if (cid === 'modal:bp_menu') {
        const placeholder = str(i.fields.getTextInputValue('placeholder'), 'Selecione uma opção').trim().slice(0, 100);
        const opcoesTxt = str(i.fields.getTextInputValue('opcoes'), '').trim();
        const labels = opcoesTxt.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 25);
        const valoresFixos = ['iniciar', 'ranking'];
        CFG.ponto.menu_placeholder = placeholder;
        CFG.ponto.menu_opcoes = labels.map(function (lb, idx) {
          return { label: lb.slice(0, 80), valor: valoresFixos[idx] || ('opcao_' + idx) };
        });
        if (CFG.ponto.menu_opcoes.length === 0) {
          CFG.ponto.menu_opcoes = [{ label: '▶️ Iniciar Ponto', valor: 'iniciar' }, { label: '🏆 Ver Ranking', valor: 'ranking' }];
        }
        return atualizarPainelConfig(i, painelBatePontoConfig, 'Texto do menu atualizado!');
      }
      if (cid.indexOf('modal:bp_') === 0) {
        const acao = cid.slice(9);
        const valor = pegarValor();
        if (acao === 'canal_painel_publico') CFG.ponto.canal_painel_publico = valor;
        else if (acao === 'canal_inicio_fim') CFG.ponto.canal_logs_inicio_fim = valor;
        else if (acao === 'canal_pausas') CFG.ponto.canal_logs_pausas = valor;
        else if (acao === 'canal_cancelados') CFG.ponto.canal_logs_cancelados = valor;
        else if (acao === 'tempo_pausa') CFG.ponto.tempo_pausa_maxima_segundos = Math.max(60, parseInt(valor, 10) || 60);
        else if (acao === 'banner_painel') CFG.ponto.banner_painel_publico = valor;
        else if (acao === 'banner_inicio') CFG.ponto.banner_inicio = valor;
        else if (acao === 'banner_fim') CFG.ponto.banner_fim = valor;
        return atualizarPainelConfig(i, painelBatePontoConfig, 'Configuração de ponto salva!');
      }

      if (cid === 'modal:sc_cargos') {
        const valor = pegarValor();
        CFG.set.cargos_setagem = valor ? valor.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
        return atualizarPainelConfig(i, painelSetConfig, 'Cargos de setagem salvos! (' + CFG.set.cargos_setagem.length + ' cargo(s))');
      }
      if (cid === 'modal:sc_times') {
        CFG.set.equipes = parseEquipes(pegarValor());
        return atualizarPainelConfig(i, painelSetConfig, 'Times/EQPs salvos! (' + CFG.set.equipes.length + ' time(s))');
      }
      if (cid === 'modal:sc_canal_logs') {
        CFG.set.canal_logs = pegarValor();
        return atualizarPainelConfig(i, painelSetConfig, 'Canal de logs definido!');
      }
      if (cid === 'modal:sc_canal_painel') {
        CFG.set.canal_painel = pegarValor();
        return atualizarPainelConfig(i, painelSetConfig, 'Canal do painel definido!');
      }
      if (cid === 'modal:sc_expiracao') {
        CFG.set.expiracao_horas = Math.max(1, parseInt(pegarValor(), 10) || 12);
        return atualizarPainelConfig(i, painelSetConfig, 'Expiração definida para ' + CFG.set.expiracao_horas + ' horas!');
      }
      if (cid === 'modal:sc_titulo') {
        CFG.set.embed_titulo = pegarValor().slice(0, 256);
        return atualizarPainelConfig(i, painelSetConfig, 'Título do painel de SET atualizado!');
      }
      if (cid === 'modal:sc_descricao') {
        CFG.set.embed_descricao = pegarValor().slice(0, 4000);
        return atualizarPainelConfig(i, painelSetConfig, 'Descrição do painel de SET atualizada!');
      }
      if (cid === 'modal:sc_banner') {
        CFG.set.banner = pegarValor();
        return atualizarPainelConfig(i, painelSetConfig, 'Banner do painel de SET atualizado!');
      }
      if (cid === 'modal:sc_botao') {
        CFG.set.botao_label = pegarValor().slice(0, 80) || '📋 Pedir Set';
        return atualizarPainelConfig(i, painelSetConfig, 'Texto do botão atualizado!');
      }

      if (cid === 'modal:set_nick') {
        const nick = str(i.fields.getTextInputValue('nick'), '').trim();
        console.log('[SET] Modal nick enviado:', nick);
        await i.deferReply({ ephemeral: true });
        const roblox = await buscarRoblox(nick);
        if (!roblox) {
          return i.editReply({ content: '⚠️ Não encontrei o nick **' + nick + '** no Roblox. Verifique a ortografia e tente novamente.' });
        }
        const equipes = CFG.set.equipes || [];
        const umaEquipeSo = equipes.length === 1;
        const umaEqpSo = umaEquipeSo && (equipes[0].eqps || []).length === 1;
        pedidosTemp[i.user.id] = {
          roblox: roblox,
          equipeIdx: umaEquipeSo ? 0 : null,
          eqp: umaEqpSo ? equipes[0].eqps[0] : null,
          setadorId: null
        };
        console.log('[SET] Montando painel de seleção...');
        const painel = await montarPainelPedido(i.guild, i.user.id);
        return i.editReply(painel);
      }

      return;
    }
  } catch (erro) {
    console.error('❌ Erro na interação:', erro);
    const resposta = { content: '⚠️ Erro inesperado.', ephemeral: true };
    try {
      if (!i.replied && !i.deferred) await i.reply(resposta).catch(function () {});
      else if (i.deferred) await i.editReply(resposta).catch(function () {});
      else if (i.replied) await i.followUp(resposta).catch(function () {});
    } catch (e2) {}
  }
});

// ============================================================
//  SERVIDOR HTTP (conecta com o site depois) — /api/stats
//  Depois: hospedar na Render/Discloud e colocar a URL no site
// ============================================================

// ============================================================

client.login(TOKEN).catch(function (e) { console.error('❌ Erro no login:', e.message); });
