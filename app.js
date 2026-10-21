/* Estúdio de Vídeos IA
 * Roda inteiro no navegador. Gemini escreve roteiros e estuda vídeos de referência;
 * Pollinations gera as cenas, a narração e hospeda as imagens; o canvas monta o vídeo final.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const POLL = 'https://gen.pollinations.ai';
const POLL_MEDIA = 'https://media.pollinations.ai';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

// ---------------------------------------------------------------- estado

const DEFAULTS = {
  geminiKey: '',
  geminiModel: 'gemini-flash-latest',
  pollKey: '',
  imageModel: 'google/gemini-3.1-flash-image',
  videoModel: 'bytedance/seedance-2.0',
  clipSeconds: 4,
  ttsProvider: 'gemini',
  geminiTtsModel: 'gemini-3.1-flash-tts-preview',
  geminiVoice: 'Zephyr',
  ttsModel: 'openai/tts-1',
  voice: 'nova',
  textProvider: 'gemini',
  pollTextModel: 'openai/gpt-5.4-nano',
  activeStyle: 'padrao',
};

const ESTILO_PADRAO = {
  id: 'padrao',
  nome: 'Padrão TikTok Shop',
  resumo: 'Gancho forte no primeiro segundo, cortes a cada 1,5 s, legenda palavra por palavra em caixa alta com destaque amarelo, zoom suave e narração animada em segunda pessoa.',
  gancho: { tipo: 'problema + curiosidade', duracao_seg: 1.5, exemplo: 'Para de sofrer com o sal empedrado!' },
  ritmo: { duracao_media_cena_seg: 1.8, cortes_por_10s: 6 },
  estrutura: ['gancho', 'problema', 'demonstração', 'benefícios', 'prova', 'chamada para o carrinho'],
  legendas: { estilo: 'palavra_por_palavra', posicao: 'centro', caixa_alta: true, cor_texto: '#FFFFFF', cor_destaque: '#FFE600', contorno: true, tamanho: 'grande' },
  efeitos: { zoom: 'leve', transicao: 'zoom', texto_gancho_na_tela: true },
  narracao: { tom: 'animado e próximo, como amiga indicando um achado', velocidade: 'rapida', pessoa: 'segunda', exemplos_frases: ['Olha que achado!', 'Corre no carrinho laranja'] },
  imagens: { tipos_de_plano: ['close nas mãos', 'antes e depois', 'plano detalhe do produto'], iluminacao: 'luz natural de janela', cenario: 'casa real, organizada' },
  musica: { clima: 'animada, batida leve' },
  dicas_para_replicar: [],
};

let settings = load('estudio.settings', DEFAULTS);
let estilos = load('estudio.estilos', []);
let projeto = null; // último vídeo gerado: { roteiro, cenas, audioBlob, produtoUrl, ... }

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (v == null) return structuredClone(fallback);
    return Array.isArray(fallback) ? v : { ...fallback, ...v };
  } catch { return structuredClone(fallback); }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn(e); }
}
function todosEstilos() { return [ESTILO_PADRAO, ...estilos]; }
function estiloAtivo() {
  const id = $('estiloSelect').value || settings.activeStyle;
  return todosEstilos().find((e) => e.id === id) || ESTILO_PADRAO;
}

// ---------------------------------------------------------------- utilidades

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function fetchTimeout(url, opts = {}, ms = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 400); } catch {}
      throw new Error(`HTTP ${res.status} em ${url.split('?')[0].slice(0, 80)}: ${body}`);
    }
    return res;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Tempo esgotado esperando ' + url.split('?')[0].slice(0, 80));
    throw e;
  } finally { clearTimeout(t); }
}

async function comRetentativa(fn, tentativas = 3, rotulo = '') {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try { return await fn(); } catch (e) {
      ultimo = e;
      if (/HTTP (400|401|402|403|404)/.test(e.message)) throw e;
      log(`${rotulo} falhou (tentativa ${i + 1}/${tentativas}): ${e.message}`);
      await sleep(2000 * (i + 1));
    }
  }
  throw ultimo;
}

async function emLotes(itens, limite, fn) {
  const out = new Array(itens.length);
  let i = 0;
  async function worker() {
    while (i < itens.length) { const k = i++; out[k] = await fn(itens[k], k); }
  }
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, worker));
  return out;
}

function parseJSON(texto) {
  let t = String(texto).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

let logAtual = 'log'; // painel de log do fluxo em andamento
function log(msg, alvo = logAtual) {
  const el = $(alvo);
  const hora = new Date().toLocaleTimeString('pt-BR');
  el.textContent += `[${hora}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function exigir(cond, msg) { if (!cond) throw new Error(msg); }

// ---------------------------------------------------------------- IA de texto

// Modelos tentados em ordem quando o escolhido está sobrecarregado (503/429/500).
const GEMINI_RESERVAS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

async function geminiChamar(modelo, body) {
  const url = `${GEMINI}/models/${encodeURIComponent(modelo)}:generateContent`;
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiKey },
    body: JSON.stringify(body),
  };
  const esperas = [4000, 10000];
  for (let i = 0; ; i++) {
    try {
      return await (await fetchTimeout(url, opts, 300000)).json();
    } catch (e) {
      const ocupado = /HTTP (429|500|503)/.test(e.message);
      if (!ocupado || i >= esperas.length) throw e;
      log(`Gemini (${modelo}) ocupado, tentando de novo em ${esperas[i] / 1000} s...`);
      await sleep(esperas[i]);
    }
  }
}

async function gemini(parts, { json = true, temperature = 0.8 } = {}) {
  exigir(settings.geminiKey, 'Coloque a chave do Gemini em Configurações.');
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
  };
  const modelos = [...new Set([settings.geminiModel, ...GEMINI_RESERVAS].filter(Boolean))];
  let data, ultimo;
  for (const modelo of modelos) {
    try { data = await geminiChamar(modelo, body); break; } catch (e) {
      ultimo = e;
      if (!/HTTP (404|429|500|503)/.test(e.message)) throw e;
      log(`Gemini (${modelo}) indisponível, trocando de modelo...`);
    }
  }
  if (!data) throw ultimo;
  const texto = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  exigir(texto, 'O Gemini não devolveu texto: ' + JSON.stringify(data).slice(0, 300));
  return json ? parseJSON(texto) : texto;
}

async function pollinationsTexto(prompt, imagemDataUrl) {
  exigir(settings.pollKey, 'Coloque a chave da Pollinations em Configurações.');
  const content = [{ type: 'text', text: prompt }];
  if (imagemDataUrl) content.push({ type: 'image_url', image_url: { url: imagemDataUrl } });
  const res = await fetchTimeout(`${POLL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.pollKey}` },
    body: JSON.stringify({
      model: settings.pollTextModel,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
    }),
  }, 300000);
  const data = await res.json();
  return parseJSON(data.choices[0].message.content);
}

// ---------------------------------------------------------------- Pollinations: mídia

function pollHeaders() {
  exigir(settings.pollKey, 'Coloque a chave da Pollinations em Configurações.');
  return { Authorization: `Bearer ${settings.pollKey}` };
}

async function uploadMidia(blob, nome = 'arquivo') {
  const fd = new FormData();
  fd.append('file', blob, nome);
  const res = await fetchTimeout(`${POLL_MEDIA}/upload`, { method: 'POST', headers: pollHeaders(), body: fd }, 120000);
  const data = await res.json();
  exigir(data.url, 'Upload sem URL de retorno: ' + JSON.stringify(data).slice(0, 200));
  return data.url;
}

async function gerarImagem(prompt, referenciaUrl) {
  const p = new URLSearchParams({ model: settings.imageModel, width: '768', height: '1344', seed: '-1' });
  if (referenciaUrl) p.set('image', referenciaUrl);
  const url = `${POLL}/image/${encodeURIComponent(prompt)}?${p}`;
  const res = await fetchTimeout(url, { headers: pollHeaders() }, 180000);
  const blob = await res.blob();
  exigir(blob.type.startsWith('image'), 'A resposta de imagem não é uma imagem (' + blob.type + ').');
  return blob;
}

async function gerarVideo(prompt, imagemInicialUrl, segundos) {
  const p = new URLSearchParams({ model: settings.videoModel, duration: String(segundos), aspectRatio: '9:16', audio: 'false' });
  if (imagemInicialUrl) p.set('image', imagemInicialUrl);
  const url = `${POLL}/video/${encodeURIComponent(prompt)}?${p}`;
  const res = await fetchTimeout(url, { headers: pollHeaders() }, 600000);
  const blob = await res.blob();
  exigir(blob.type.startsWith('video') || blob.size > 50000, 'A resposta de vídeo não é um vídeo (' + blob.type + ').');
  return blob;
}

function pcmParaWav(b64, taxa = 24000) {
  const pcm = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const buf = new ArrayBuffer(44 + pcm.length);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, taxa, true); v.setUint32(28, taxa * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

// Voz grátis do Gemini. Se o modelo configurado não existir, tenta o anterior.
async function gerarVozGemini(texto, estilo) {
  exigir(settings.geminiKey, 'Coloque a chave do Gemini em Configurações.');
  const modelos = [...new Set([settings.geminiTtsModel, 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'].filter(Boolean))];
  const fala = `Leia em português do Brasil, voz feminina, tom ${estilo.narracao?.tom || 'animado e próximo'}, ritmo ${estilo.narracao?.velocidade || 'rápido'} de vídeo de TikTok vendendo um achado:\n\n${texto}`;
  let ultimo;
  for (const modelo of modelos) {
    try {
      const res = await fetchTimeout(`${GEMINI}/models/${encodeURIComponent(modelo)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fala }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.geminiVoice || 'Zephyr' } } },
          },
        }),
      }, 180000);
      const data = await res.json();
      const parte = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
      const inline = parte?.inlineData || parte?.inline_data;
      exigir(inline?.data, 'O Gemini não devolveu áudio.');
      const taxa = Number(/rate=(\d+)/.exec(inline.mimeType || inline.mime_type || '')?.[1]) || 24000;
      return pcmParaWav(inline.data, taxa);
    } catch (e) { ultimo = e; log(`Voz com ${modelo} falhou: ${e.message}`); }
  }
  throw ultimo;
}

async function gerarVoz(texto, estilo) {
  if (settings.ttsProvider === 'gemini') return gerarVozGemini(texto, estilo);
  const res = await fetchTimeout(`${POLL}/v1/audio/speech`, {
    method: 'POST',
    headers: { ...pollHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: texto,
      model: settings.ttsModel,
      voice: settings.voice,
      response_format: 'mp3',
      instructions: `Fale em português do Brasil, sotaque brasileiro natural. Tom: ${estilo.narracao?.tom || 'animado'}. Ritmo: ${estilo.narracao?.velocidade || 'rápido'}, como vídeo de TikTok vendendo um achado.`,
    }),
  }, 180000);
  return res.blob();
}

// ---------------------------------------------------------------- prompts

const CONHECIMENTO_VENDAS = `
Princípios de vídeos curtos que vendem (baseados em dados de retenção do TikTok e em psicologia de persuasão):
- Os 1 a 2 primeiros segundos decidem tudo: abra com quebra de padrão (movimento forte, antes/depois, resultado primeiro), chame a dor pelo nome ("Seu sal empedra?") ou abra uma lacuna de curiosidade ("Ninguém te conta isso sobre...").
- Estrutura PAS: Problema, Agitação (mostre a frustração do dia a dia), Solução (o produto resolvendo na tela).
- Mostre, não diga: a demonstração do produto em uso converte mais que qualquer frase. Cada cena mostra uma ação concreta com as mãos.
- Benefício antes de característica: "nunca mais sal empedrado" vale mais que "tampa vedada".
- Especificidade gera confiança: números, medidas, tempo economizado (somente fatos plausíveis do produto, nunca invente avaliações, depoimentos ou resultados).
- Ancoragem de preço e valor percebido ("menos que um lanche") quando houver preço.
- Urgência leve e honesta ("está com desconto agora no carrinho"), nunca falsa.
- Chamada para ação clara e repetida no fim: "Toca no carrinho laranja".
- Cortes a cada 1 a 2 segundos, legenda grande e frases curtas (até 8 palavras por frase).
- Proibido: rosto de pessoas, promessas de saúde, emagrecimento ou dinheiro, citar marcas concorrentes.
`;

function promptAprender(nome, obs) {
  return `Você é um editor sênior de vídeos virais de TikTok Shop. Assista ao vídeo anexado com atenção (imagem, cortes, textos na tela, narração, música, efeitos) e faça engenharia reversa da edição para que outra IA consiga REPLICAR o mesmo estilo com outros produtos.
${obs ? 'Observação do usuário: ' + obs : ''}
Responda SOMENTE com JSON válido neste formato (valores de exemplo, preencha com o que observar):
{
  "nome": ${JSON.stringify(nome || '')},
  "resumo": "2 frases descrevendo o estilo",
  "gancho": {"tipo": "ex.: resultado primeiro, pergunta, problema", "duracao_seg": 1.5, "exemplo": "texto ou fala exata do gancho do vídeo"},
  "ritmo": {"duracao_media_cena_seg": 1.5, "cortes_por_10s": 6},
  "estrutura": ["gancho", "problema", "demonstração", "..."],
  "legendas": {"estilo": "palavra_por_palavra ou frase", "posicao": "centro, inferior ou superior", "caixa_alta": true, "cor_texto": "#FFFFFF", "cor_destaque": "#FFE600", "contorno": true, "tamanho": "grande ou medio"},
  "efeitos": {"zoom": "forte, leve ou nenhum", "transicao": "corte_seco, flash ou zoom", "texto_gancho_na_tela": true},
  "narracao": {"tom": "descrição do tom de voz", "velocidade": "rapida ou normal", "pessoa": "primeira ou segunda", "exemplos_frases": ["frases marcantes ditas no vídeo"]},
  "imagens": {"tipos_de_plano": ["close nas mãos", "..."], "iluminacao": "...", "cenario": "..."},
  "musica": {"clima": "..."},
  "linha_do_tempo": [{"inicio_seg": 0, "fim_seg": 1.5, "imagem": "o que aparece", "texto_na_tela": "...", "narracao": "..."}],
  "roteiro_transcrito": "transcrição da narração",
  "dicas_para_replicar": ["regras práticas para copiar este estilo"]
}`;
}

function promptRoteiro({ nome, nicho, preco, contexto, duracao, estilo }) {
  const nCenas = Math.max(4, Math.min(12, Math.round(duracao / (estilo.ritmo?.duracao_media_cena_seg || 2))));
  const est = { ...estilo };
  delete est.id;
  return `Você é roteirista de vídeos de TikTok Shop que vendem muito no Brasil, especialista em conteúdo sem rosto (só mãos e produto).
${CONHECIMENTO_VENDAS}
ESTILO DE EDIÇÃO A SEGUIR (aprendido de um vídeo de referência; copie gancho, ritmo, estrutura, tom e tipos de plano):
${JSON.stringify(est, null, 1)}

PRODUTO: ${nome}
NICHO: ${nicho}
${preco ? 'PREÇO: ' + preco : ''}
CONTEXTO DO USUÁRIO: ${contexto || '(nenhum)'}
A imagem anexada é a foto real do produto: descreva-o fielmente nos prompts de imagem (cor, formato, material, tampa etc.).

Crie um roteiro de ${duracao} segundos com exatamente ${nCenas} cenas. A narração inteira, lida em ritmo de TikTok, deve caber em ${duracao} segundos (cerca de ${Math.round(duracao * 2.6)} palavras no total).
Para cada cena escreva:
- "narracao": a fala daquela cena em português do Brasil, frases curtas.
- "legenda": texto curto na tela (até 6 palavras).
- "prompt_imagem": prompt EM INGLÊS para gerar a foto vertical da cena: cenário realista (${estilo.imagens?.cenario || 'casa brasileira real'}), ${estilo.imagens?.iluminacao || 'luz natural'}, mãos de uma pessoa usando o produto, sem rosto, estilo vídeo de celular UGC. Descreva o produto exatamente como na foto.
- "prompt_movimento": prompt EM INGLÊS curto do movimento da cena para IA de vídeo (ex.: "hands pour salt into the container, slow push-in camera").

Responda SOMENTE com JSON válido:
{
  "titulo": "...",
  "gancho": "frase do gancho (mostrada na tela no início)",
  "cenas": [{"duracao_seg": 2, "narracao": "...", "legenda": "...", "prompt_imagem": "...", "prompt_movimento": "..."}],
  "legenda_post": "legenda para o post do TikTok com chamada para o carrinho",
  "hashtags": ["#tiktokshop", "..."]
}`;
}

// ---------------------------------------------------------------- etapas na tela

const ETAPAS = ['Roteiro com gancho', 'Envio da foto do produto', 'Cenas com IA', 'Narração', 'Montagem do vídeo'];
function iniciarEtapas() {
  $('etapas').innerHTML = ETAPAS.map((e) => `<li>${e}</li>`).join('');
  $('log').textContent = '';
}
function etapa(i, estado) {
  const li = $('etapas').children[i];
  if (li) li.className = estado;
}

// ---------------------------------------------------------------- fluxo principal

async function criarVideo() {
  const foto = $('fotoProduto').files[0];
  const nome = $('nomeProduto').value.trim();
  const btn = $('btnCriar');
  try {
    exigir(foto, 'Escolha a foto do produto.');
    exigir(nome, 'Escreva o nome do produto.');
    btn.disabled = true;
    logAtual = 'log';
    iniciarEtapas();
    $('cardFinal').classList.add('hidden');
    const estilo = estiloAtivo();
    const duracao = Number($('duracao').value);
    const modo = $('modoCena').value;

    // 1. roteiro
    etapa(0, 'run');
    log(`Escrevendo roteiro no estilo "${estilo.nome}"...`);
    const fotoB64 = await fileToBase64(foto);
    const prompt = promptRoteiro({ nome, nicho: $('nicho').value, preco: $('preco').value.trim(), contexto: $('contexto').value.trim(), duracao, estilo });
    const roteiro = await comRetentativa(() => settings.textProvider === 'pollinations'
      ? pollinationsTexto(prompt, `data:${foto.type};base64,${fotoB64}`)
      : gemini([{ inline_data: { mime_type: foto.type || 'image/jpeg', data: fotoB64 } }, { text: prompt }]), 2, 'Roteiro');
    exigir(Array.isArray(roteiro.cenas) && roteiro.cenas.length, 'Roteiro veio sem cenas.');
    etapa(0, 'done');
    projeto = { roteiro, estilo, modo, foto, cenas: roteiro.cenas.map((c) => ({ ...c, imagemBlob: null, videoBlob: null, status: 'aguardando' })) };
    mostrarRoteiro();

    // 2. upload da foto (o modo grátis usa a própria foto e não precisa disso)
    etapa(1, 'run');
    if (modo === 'foto' || modo === 'manual') {
      projeto.cenas.forEach((c) => { c.imagemBlob = foto; c.status = 'foto do produto'; });
      projeto.cenas.forEach((_, i) => atualizarCena(i));
      etapa(1, 'done');
    } else try {
      projeto.produtoUrl = await comRetentativa(() => uploadMidia(foto, foto.name || 'produto.jpg'), 2, 'Upload');
      log('Foto do produto enviada.');
      etapa(1, 'done');
    } catch (e) {
      projeto.produtoUrl = null;
      log('Não consegui enviar a foto; as cenas serão geradas só pela descrição. ' + e.message);
      etapa(1, 'fail');
    }

    // 3. cenas e 4. voz em paralelo
    etapa(2, 'run');
    etapa(3, 'run');
    const narracao = projeto.cenas.map((c) => c.narracao).join(' ');
    const vozPromise = comRetentativa(() => gerarVoz(narracao, estilo), 2, 'Narração')
      .then((b) => { projeto.audioBlob = b; etapa(3, 'done'); log('Narração pronta.'); })
      .catch((e) => { projeto.audioBlob = null; etapa(3, 'fail'); log('Sem narração: ' + e.message); });
    if (modo !== 'foto' && modo !== 'manual') await emLotes(projeto.cenas, modo === 'video' ? 2 : 3, (c, i) => gerarCena(i));
    await vozPromise;
    const ok = projeto.cenas.filter((c) => c.imagemBlob || c.videoBlob).length;
    exigir(ok > 0, 'Nenhuma cena foi gerada. Veja o log e confira a chave e o modelo da Pollinations.');
    etapa(2, ok === projeto.cenas.length ? 'done' : 'fail');

    // 5. montagem
    if (modo === 'manual') {
      etapa(4, '');
      log('Roteiro e narração prontos. Em cada cena, clique em "Copiar prompt", cole no Gemini junto com a foto do produto, baixe a imagem ou o vídeo e clique em "Enviar minha cena". Depois clique em "Montar vídeo".');
      $('cardRoteiro').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    await montar();
  } catch (e) {
    log('ERRO: ' + e.message);
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function gerarCena(i) {
  const c = projeto.cenas[i];
  const estilo = projeto.estilo;
  const promptImg = `${c.prompt_imagem}. Vertical 9:16 smartphone photo, realistic, only hands visible, no face, ${estilo.imagens?.iluminacao || 'natural light'}. The product must look exactly like the reference image.`;
  c.status = 'gerando imagem';
  atualizarCena(i);
  try {
    c.imagemBlob = await comRetentativa(() => gerarImagem(promptImg, projeto.produtoUrl), 3, `Imagem da cena ${i + 1}`);
    c.status = 'imagem pronta';
    atualizarCena(i);
    log(`Cena ${i + 1}: imagem pronta.`);
    if (projeto.modo === 'video') {
      c.status = 'gerando vídeo';
      atualizarCena(i);
      const imgUrl = await comRetentativa(() => uploadMidia(c.imagemBlob, `cena${i + 1}.jpg`), 2, `Upload da cena ${i + 1}`);
      c.videoBlob = await comRetentativa(() => gerarVideo(`${c.prompt_movimento}. ${c.prompt_imagem}. Only hands, no face, realistic.`, imgUrl, settings.clipSeconds), 2, `Vídeo da cena ${i + 1}`);
      c.status = 'vídeo pronto';
      log(`Cena ${i + 1}: vídeo pronto.`);
    }
  } catch (e) {
    if (!c.imagemBlob && /HTTP 402/.test(e.message)) {
      c.imagemBlob = projeto.foto;
      c.status = 'sem créditos: usando a foto';
      log(`Cena ${i + 1}: sem créditos na Pollinations, usei a foto do produto.`);
      atualizarCena(i);
      return;
    }
    c.status = c.imagemBlob ? 'só imagem' : 'falhou';
    log(`Cena ${i + 1}: ${e.message}`);
  }
  atualizarCena(i);
}

function mostrarRoteiro() {
  const r = projeto.roteiro;
  $('cardRoteiro').classList.remove('hidden');
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  $('roteiro').innerHTML = `<p><b>${esc(r.titulo)}</b></p><p>Gancho: <b>${esc(r.gancho)}</b></p><button id="btnMontar" class="primary">Montar vídeo</button>`;
  $('cenas').innerHTML = projeto.cenas.map((c, i) => `
    <div class="cena" id="cena${i}">
      <div class="thumb"><span class="st"></span></div>
      <div class="txt"><b>${i + 1}. ${esc(c.legenda)}</b><br>${esc(c.narracao)}</div>
      <button data-copiar="${i}">Copiar prompt (Gemini)</button>
      <label class="filebtn cenabtn">Enviar minha cena<input type="file" accept="image/*,video/*" data-enviar="${i}"></label>
      <button data-refazer="${i}">Gerar com Pollinations</button>
    </div>`).join('');
  projeto.cenas.forEach((_, i) => atualizarCena(i));
}

function promptGemini(i) {
  const c = projeto.cenas[i];
  return `Use a foto do produto que anexei (${$('nomeProduto').value.trim()}). Mantenha o produto idêntico ao da foto.
Crie uma imagem vertical 9:16, realista, estilo vídeo de celular, só as mãos de uma pessoa aparecem (sem rosto):
${c.prompt_imagem}

Se for gerar vídeo (Veo), use este movimento: ${c.prompt_movimento}. Sem fala e sem texto na tela.`;
}

function enviarCena(i, arquivo) {
  const c = projeto.cenas[i];
  const el = $('cena' + i);
  el.querySelector('.thumb video')?.remove();
  el.querySelector('.thumb').style.backgroundImage = '';
  if (arquivo.type.startsWith('video')) { c.videoBlob = arquivo; c.imagemBlob = null; } else { c.imagemBlob = arquivo; c.videoBlob = null; }
  c.status = 'enviada por você';
  atualizarCena(i);
}

function atualizarCena(i) {
  const c = projeto.cenas[i];
  const el = $('cena' + i);
  if (!el) return;
  const thumb = el.querySelector('.thumb');
  if (c.videoBlob && !thumb.querySelector('video')) {
    const v = document.createElement('video');
    v.src = URL.createObjectURL(c.videoBlob);
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    thumb.prepend(v);
  } else if (c.imagemBlob && !c.videoBlob) {
    thumb.style.backgroundImage = `url(${URL.createObjectURL(c.imagemBlob)})`;
  }
  thumb.querySelector('.st').textContent = c.status;
  el.toggleAttribute('data-gerando', /^gerando/.test(c.status));
}

async function refazerCena(i) {
  if (!projeto) return;
  if (projeto.modo === 'foto') projeto.modo = 'imagem';
  const c = projeto.cenas[i];
  c.imagemBlob = null; c.videoBlob = null;
  const el = $('cena' + i);
  el.querySelector('.thumb video')?.remove();
  el.querySelector('.thumb').style.backgroundImage = '';
  await gerarCena(i);
}

// ---------------------------------------------------------------- montagem (canvas + MediaRecorder)

function escolherFormato() {
  const opcoes = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return opcoes.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

function carregarImagem(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Imagem inválida'));
    img.src = URL.createObjectURL(blob);
  });
}

function carregarVideoEl(blob) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.loop = true; v.preload = 'auto';
    v.oncanplaythrough = () => resolve(v);
    v.onerror = () => reject(new Error('Vídeo inválido'));
    v.src = URL.createObjectURL(blob);
    v.load();
  });
}

function desenharCover(ctx, src, W, H, escala, dx, dy) {
  const sw = src.videoWidth || src.naturalWidth || src.width;
  const sh = src.videoHeight || src.naturalHeight || src.height;
  if (!sw || !sh) return;
  const s = Math.max(W / sw, H / sh) * escala;
  const w = sw * s, h = sh * s;
  ctx.drawImage(src, (W - w) / 2 + dx, (H - h) / 2 + dy, w, h);
}

function quebrarLinhas(ctx, texto, larguraMax) {
  const palavras = texto.split(/\s+/).filter(Boolean);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    const teste = atual ? atual + ' ' + p : p;
    if (ctx.measureText(teste).width > larguraMax && atual) { linhas.push(atual); atual = p; } else atual = teste;
  }
  if (atual) linhas.push(atual);
  return linhas;
}

function desenharTexto(ctx, texto, { W, H, y, tamanho, cor, destaqueIdx = -1, corDestaque, contorno, caixaAlta, fundo }) {
  if (!texto) return;
  ctx.save();
  ctx.font = `900 ${tamanho}px "Arial Black", "Segoe UI Black", Impact, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const t = caixaAlta ? texto.toUpperCase() : texto;
  const linhas = quebrarLinhas(ctx, t, W * 0.84);
  const alturaLinha = tamanho * 1.15;
  let yy = y - ((linhas.length - 1) * alturaLinha) / 2;
  let idxPalavra = 0;
  for (const linha of linhas) {
    const palavras = linha.split(' ');
    const larguraTotal = ctx.measureText(linha).width;
    let x = (W - larguraTotal) / 2;
    if (fundo) {
      ctx.fillStyle = fundo;
      ctx.fillRect(x - 24, yy - alturaLinha / 2, larguraTotal + 48, alturaLinha);
    }
    for (const p of palavras) {
      const wP = ctx.measureText(p).width;
      if (contorno) {
        ctx.lineWidth = tamanho * 0.16;
        ctx.strokeStyle = '#000';
        ctx.lineJoin = 'round';
        ctx.strokeText(p, x, yy);
      }
      ctx.fillStyle = idxPalavra === destaqueIdx ? corDestaque : cor;
      ctx.fillText(p, x, yy);
      x += wP + ctx.measureText(' ').width;
      idxPalavra++;
    }
    yy += alturaLinha;
  }
  ctx.restore();
}

function montarLinhaDoTempo(cenas, duracaoAudio) {
  const pesos = cenas.map((c) => Math.max(2, String(c.narracao || '').split(/\s+/).filter(Boolean).length));
  const soma = pesos.reduce((a, b) => a + b, 0);
  let t = 0;
  return cenas.map((c, i) => {
    const d = duracaoAudio
      ? Math.max(0.9, (duracaoAudio * pesos[i]) / soma)
      : Math.max(0.9, Number(c.duracao_seg) || 2);
    const item = { ...c, inicio: t, fim: t + d };
    t += d;
    return item;
  });
}

async function montar() {
  exigir(projeto, 'Crie um vídeo primeiro.');
  etapa(4, 'run');
  log('Montando o vídeo. Isso leva o mesmo tempo que a duração do vídeo; deixe a aba visível.');
  const estilo = projeto.estilo;
  const leg = { ...ESTILO_PADRAO.legendas, ...(estilo.legendas || {}) };
  const ef = { ...ESTILO_PADRAO.efeitos, ...(estilo.efeitos || {}) };
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // fontes das cenas (vídeo quando existe, senão imagem; cenas que falharam reaproveitam a anterior)
  const fontes = [];
  for (const c of projeto.cenas) {
    let f = null;
    try {
      if (c.videoBlob) f = { tipo: 'video', el: await carregarVideoEl(c.videoBlob) };
      else if (c.imagemBlob) f = { tipo: 'imagem', el: await carregarImagem(c.imagemBlob) };
    } catch (e) { log('Cena ignorada: ' + e.message); }
    fontes.push(f);
  }
  for (let i = 0; i < fontes.length; i++) {
    if (!fontes[i]) fontes[i] = fontes[i - 1] || fontes.find(Boolean);
  }

  // áudio
  const actx = new AudioContext();
  const destino = actx.createMediaStreamDestination();
  let bufVoz = null, bufMusica = null;
  if (projeto.audioBlob) {
    try { bufVoz = await actx.decodeAudioData(await projeto.audioBlob.arrayBuffer()); } catch (e) { log('Não consegui ler a narração: ' + e.message); }
  }
  const arqMusica = $('musica').files[0];
  if (arqMusica) {
    try { bufMusica = await actx.decodeAudioData(await arqMusica.arrayBuffer()); } catch (e) { log('Não consegui ler a música: ' + e.message); }
  }

  const linha = montarLinhaDoTempo(projeto.cenas, bufVoz ? bufVoz.duration : 0);
  const total = linha[linha.length - 1].fim + 0.5;

  const stream = canvas.captureStream(30);
  destino.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mime = escolherFormato();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  const pedacos = [];
  rec.ondataavailable = (e) => { if (e.data.size) pedacos.push(e.data); };
  const terminou = new Promise((r) => { rec.onstop = r; });

  const zoomMax = ef.zoom === 'forte' ? 0.2 : ef.zoom === 'nenhum' ? 0 : 0.09;
  const tamanho = leg.tamanho === 'medio' ? 64 : 84;
  const yLegenda = leg.posicao === 'superior' ? H * 0.2 : leg.posicao === 'inferior' ? H * 0.78 : H * 0.62;

  function quadro(t) {
    const k = Math.max(0, linha.findIndex((c) => t < c.fim));
    const idx = t >= linha[linha.length - 1].fim ? linha.length - 1 : k;
    const cena = linha[idx];
    const f = fontes[idx];
    const local = Math.min(1, (t - cena.inicio) / (cena.fim - cena.inicio));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (f) {
      let escala = 1 + zoomMax * (idx % 2 ? 1 - local : local);
      if (ef.transicao === 'zoom' && t - cena.inicio < 0.18) escala += 0.08 * (1 - (t - cena.inicio) / 0.18);
      const pan = (idx % 3 - 1) * 30 * local;
      desenharCover(ctx, f.el, W, H, escala, pan, 0);
    }
    if (ef.transicao === 'flash' && t - cena.inicio < 0.12 && idx > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.7 * (1 - (t - cena.inicio) / 0.12)})`;
      ctx.fillRect(0, 0, W, H);
    }
    // gancho no topo durante a primeira cena
    if (ef.texto_gancho_na_tela && idx === 0 && projeto.roteiro.gancho) {
      desenharTexto(ctx, projeto.roteiro.gancho, { W, H, y: H * 0.16, tamanho: 70, cor: '#000', contorno: false, caixaAlta: leg.caixa_alta, fundo: '#FFFFFF' });
    }
    // legenda
    if (leg.estilo === 'frase') {
      desenharTexto(ctx, cena.legenda, { W, H, y: yLegenda, tamanho, cor: leg.cor_texto, contorno: leg.contorno, caixaAlta: leg.caixa_alta });
    } else {
      const palavras = String(cena.narracao || cena.legenda || '').split(/\s+/).filter(Boolean);
      if (palavras.length) {
        const atual = Math.min(palavras.length - 1, Math.floor(local * palavras.length));
        const ini = Math.floor(atual / 3) * 3;
        desenharTexto(ctx, palavras.slice(ini, ini + 3).join(' '), { W, H, y: yLegenda, tamanho, cor: leg.cor_texto, destaqueIdx: atual - ini, corDestaque: leg.cor_destaque, contorno: leg.contorno, caixaAlta: leg.caixa_alta });
      }
    }
    return idx;
  }

  // desenha o primeiro quadro antes de começar a gravar
  quadro(0);
  await actx.resume();
  const inicioAudio = actx.currentTime + 0.1;
  if (bufVoz) { const s = actx.createBufferSource(); s.buffer = bufVoz; s.connect(destino); s.start(inicioAudio); }
  if (bufMusica) {
    const s = actx.createBufferSource(); s.buffer = bufMusica; s.loop = true;
    const g = actx.createGain(); g.gain.value = bufVoz ? 0.12 : 0.5;
    s.connect(g).connect(destino); s.start(inicioAudio);
  }
  rec.start(250);
  const t0 = performance.now() + 100;
  let cenaTocando = -1;

  await new Promise((resolve) => {
    function loop() {
      const t = Math.max(0, (performance.now() - t0) / 1000);
      const idx = quadro(t);
      if (idx !== cenaTocando) {
        fontes.forEach((f, j) => { if (f?.tipo === 'video' && j !== idx) f.el.pause(); });
        const f = fontes[idx];
        if (f?.tipo === 'video') { f.el.currentTime = 0; f.el.play().catch(() => {}); }
        cenaTocando = idx;
      }
      if (t >= total) return resolve();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });

  rec.stop();
  await terminou;
  fontes.forEach((f) => f?.tipo === 'video' && f.el.pause());
  actx.close();

  const tipo = (mime || 'video/webm').split(';')[0];
  const blob = new Blob(pedacos, { type: tipo });
  projeto.videoFinal = blob;
  const url = URL.createObjectURL(blob);
  $('videoFinal').src = url;
  const ext = tipo.includes('mp4') ? 'mp4' : 'webm';
  const base = (projeto.roteiro.titulo || 'video').toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
  $('btnBaixar').href = url;
  $('btnBaixar').download = `${base}.${ext}`;
  $('legendaPost').value = `${projeto.roteiro.legenda_post || ''}\n\n${(projeto.roteiro.hashtags || []).join(' ')}`.trim();
  $('cardFinal').classList.remove('hidden');
  etapa(4, 'done');
  log(`Vídeo pronto: ${total.toFixed(1)} s, ${(blob.size / 1e6).toFixed(1)} MB, formato ${ext.toUpperCase()}.`);
  $('cardFinal').scrollIntoView({ behavior: 'smooth' });
}

// ---------------------------------------------------------------- aprender edição

async function aprenderEdicao() {
  const arq = $('videoRef').files[0];
  const btn = $('btnAprender');
  $('logAprender').textContent = '';
  try {
    exigir(arq, 'Escolha um vídeo de referência.');
    exigir(arq.size < 19 * 1024 * 1024, 'O vídeo tem mais de 18 MB. Corte ou comprima (ex.: no CapCut, exporte em 720p) e envie de novo.');
    btn.disabled = true;
    logAtual = 'logAprender';
    log('Enviando o vídeo para o Gemini estudar. Pode levar até 1 minuto...');
    const b64 = await fileToBase64(arq);
    const nome = $('nomeEstilo').value.trim() || arq.name.replace(/\.[^.]+$/, '');
    const perfil = await comRetentativa(() => gemini([
      { inline_data: { mime_type: arq.type || 'video/mp4', data: b64 } },
      { text: promptAprender(nome, $('obsEstilo').value.trim()) },
    ], { temperature: 0.3 }), 1, 'Estudo');
    perfil.id = 'e' + Date.now();
    perfil.nome = perfil.nome || nome;
    estilos.push(perfil);
    save('estudio.estilos', estilos);
    settings.activeStyle = perfil.id;
    save('estudio.settings', settings);
    renderEstilos();
    log(`Estilo "${perfil.nome}" aprendido e selecionado.`, 'logAprender');
  } catch (e) {
    log('ERRO: ' + e.message, 'logAprender');
  } finally {
    btn.disabled = false;
  }
}

function renderEstilos() {
  const sel = $('estiloSelect');
  sel.innerHTML = todosEstilos().map((e) => `<option value="${e.id}">${e.nome.replace(/</g, '&lt;')}</option>`).join('');
  sel.value = todosEstilos().some((e) => e.id === settings.activeStyle) ? settings.activeStyle : 'padrao';
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  $('listaEstilos').innerHTML = todosEstilos().map((e) => `
    <div class="estilo${e.id === sel.value ? ' ativo' : ''}">
      <h3>${esc(e.nome)}${e.id === sel.value ? '<span class="tag">em uso</span>' : ''}</h3>
      <div class="hint">${esc(e.resumo)}</div>
      <details><summary>Ver o que a IA aprendeu</summary><pre>${esc(JSON.stringify(e, null, 2))}</pre></details>
      <div class="acoes">
        <button data-usar="${e.id}">Usar este estilo</button>
        ${e.id !== 'padrao' ? `<button data-apagar="${e.id}">Apagar</button>` : ''}
      </div>
    </div>`).join('');
}

// ---------------------------------------------------------------- configurações

const CAMPOS = ['geminiKey', 'geminiModel', 'pollKey', 'imageModel', 'videoModel', 'clipSeconds', 'ttsProvider', 'geminiTtsModel', 'geminiVoice', 'ttsModel', 'voice', 'textProvider'];

function preencherConfig() { CAMPOS.forEach((k) => { $(k).value = settings[k] ?? ''; }); }
function lerConfig() {
  CAMPOS.forEach((k) => { settings[k] = $(k).value.trim(); });
  settings.clipSeconds = Number(settings.clipSeconds) || 4;
  save('estudio.settings', settings);
}

function nomesDeModelos(json) {
  const lista = Array.isArray(json) ? json : json.data || json.models || [];
  return lista.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}
function preencherLista(id, nomes) { $(id).innerHTML = nomes.map((n) => `<option value="${n}"></option>`).join(''); }

async function carregarModelosPoll() {
  lerConfig();
  $('logTeste').textContent = '';
  for (const [rota, lista] of [['/image/models', 'imageModelsList'], ['/video/models', 'videoModelsList']]) {
    try {
      const res = await fetchTimeout(POLL + rota, { headers: settings.pollKey ? pollHeaders() : {} }, 30000);
      const nomes = nomesDeModelos(await res.json());
      preencherLista(lista, nomes);
      log(`${rota}: ${nomes.length} modelos (${nomes.slice(0, 8).join(', ')}...)`, 'logTeste');
    } catch (e) { log(`${rota}: ${e.message}`, 'logTeste'); }
  }
}

async function carregarModelosGemini() {
  lerConfig();
  $('logTeste').textContent = '';
  try {
    exigir(settings.geminiKey, 'Coloque a chave do Gemini primeiro.');
    const res = await fetchTimeout(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': settings.geminiKey } }, 30000);
    const data = await res.json();
    const nomes = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
    preencherLista('geminiModelsList', nomes);
    log(`Gemini: ${nomes.length} modelos. Sugestão: um "flash" (rápido e grátis). ${nomes.slice(0, 10).join(', ')}`, 'logTeste');
  } catch (e) { log('Gemini: ' + e.message, 'logTeste'); }
}

async function testarConexoes() {
  lerConfig();
  logAtual = 'logTeste';
  $('logTeste').textContent = '';
  try {
    const r = await gemini([{ text: 'Responda só com JSON: {"ok": true}' }], { temperature: 0 });
    log('Gemini OK: ' + JSON.stringify(r), 'logTeste');
  } catch (e) { log('Gemini falhou: ' + e.message, 'logTeste'); }
  try {
    const b = await gerarImagem('a small glass salt container on a kitchen counter, photo', null);
    log(`Pollinations imagem OK (${Math.round(b.size / 1024)} KB).`, 'logTeste');
    const u = await uploadMidia(b, 'teste.jpg');
    log('Pollinations upload OK: ' + u, 'logTeste');
  } catch (e) { log('Pollinations falhou: ' + e.message, 'logTeste'); }
}

async function testarVoz(provedor) {
  lerConfig();
  const original = settings.ttsProvider;
  settings.ttsProvider = provedor;
  try {
    const b = await gerarVoz('Olha esse achado! Nunca mais sal empedrado na sua cozinha. Toca no carrinho laranja!', estiloAtivo());
    const a = $('audioTeste');
    a.src = URL.createObjectURL(b);
    a.classList.remove('hidden');
    a.play().catch(() => {});
  } catch (e) { alert('Voz falhou: ' + e.message); }
  finally { settings.ttsProvider = original; }
}

// ---------------------------------------------------------------- eventos

function moverIndicador(container) {
  const ativo = container.querySelector('button.active');
  const ind = container.querySelector('.indicator');
  if (!ativo || !ind || !ativo.offsetWidth) return;
  ind.style.width = ativo.offsetWidth + 'px';
  ind.style.transform = `translateX(${ativo.offsetLeft}px)`;
}

function trocarAba(container, attr, prefixo, valor) {
  container.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset[attr] === valor));
  moverIndicador(container);
  if (prefixo === 'tab-') requestAnimationFrame(() => moverIndicador($('subTabs')));
  document.querySelectorAll(prefixo === 'tab-' ? '.tab' : '.sub').forEach((s) => s.classList.toggle('active', s.id === prefixo + valor));
}

function iniciar() {
  preencherConfig();
  [$('mainTabs'), $('subTabs')].forEach((n) => {
    const ind = n.querySelector('.indicator');
    ind.style.transition = 'none';
    moverIndicador(n);
    requestAnimationFrame(() => { ind.style.transition = ''; });
  });
  window.addEventListener('resize', () => { moverIndicador($('mainTabs')); moverIndicador($('subTabs')); });
  document.fonts?.ready.then(() => moverIndicador($('mainTabs')));
  renderEstilos();
  $('mainTabs').addEventListener('click', (e) => { const t = e.target.dataset.tab; if (t) trocarAba($('mainTabs'), 'tab', 'tab-', t); });
  $('subTabs').addEventListener('click', (e) => { const t = e.target.dataset.sub; if (t) trocarAba($('subTabs'), 'sub', 'sub-', t); });

  $('fotoProduto').addEventListener('change', () => {
    const f = $('fotoProduto').files[0];
    if (f) { $('previewFoto').src = URL.createObjectURL(f); $('previewFoto').classList.remove('hidden'); }
  });
  $('videoRef').addEventListener('change', () => {
    const f = $('videoRef').files[0];
    if (f) { $('previewRef').src = URL.createObjectURL(f); $('previewRef').classList.remove('hidden'); }
  });
  $('estiloSelect').addEventListener('change', () => { settings.activeStyle = $('estiloSelect').value; save('estudio.settings', settings); renderEstilos(); });

  $('btnCriar').addEventListener('click', criarVideo);
  $('btnRemontar').addEventListener('click', async () => {
    try { await montar(); } catch (e) { alert(e.message); }
  });
  $('cenas').addEventListener('click', (e) => {
    const { refazer, copiar } = e.target.dataset;
    if (refazer != null) refazerCena(Number(refazer));
    if (copiar != null) {
      navigator.clipboard.writeText(promptGemini(Number(copiar)));
      e.target.textContent = 'Copiado!';
      setTimeout(() => { e.target.textContent = 'Copiar prompt (Gemini)'; }, 1500);
    }
  });
  $('cenas').addEventListener('change', (e) => { const i = e.target.dataset.enviar; if (i != null && e.target.files[0]) enviarCena(Number(i), e.target.files[0]); });
  $('roteiro').addEventListener('click', async (e) => {
    if (e.target.id !== 'btnMontar') return;
    e.target.disabled = true;
    try { await montar(); } catch (err) { alert(err.message); } finally { e.target.disabled = false; }
  });
  $('btnCopiar').addEventListener('click', () => navigator.clipboard.writeText($('legendaPost').value));

  $('btnSalvar').addEventListener('click', () => { lerConfig(); $('statusSalvar').textContent = 'Salvo.'; setTimeout(() => { $('statusSalvar').textContent = ''; }, 2000); });
  $('btnTestar').addEventListener('click', testarConexoes);
  $('btnModelosPoll').addEventListener('click', carregarModelosPoll);
  $('btnModelosGemini').addEventListener('click', carregarModelosGemini);
  $('btnTestarVoz').addEventListener('click', () => testarVoz('pollinations'));
  $('btnTestarVozGemini').addEventListener('click', () => testarVoz('gemini'));

  $('btnAprender').addEventListener('click', aprenderEdicao);
  $('listaEstilos').addEventListener('click', (e) => {
    const usar = e.target.dataset.usar, apagar = e.target.dataset.apagar;
    if (usar) { settings.activeStyle = usar; save('estudio.settings', settings); renderEstilos(); }
    if (apagar && confirm('Apagar este estilo?')) {
      estilos = estilos.filter((x) => x.id !== apagar);
      save('estudio.estilos', estilos);
      renderEstilos();
    }
  });
  $('btnExportar').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(estilos, null, 2)], { type: 'application/json' }));
    a.download = 'estilos-de-edicao.json';
    a.click();
  });
  $('importEstilos').addEventListener('change', async () => {
    try {
      const lista = JSON.parse(await $('importEstilos').files[0].text());
      exigir(Array.isArray(lista), 'Arquivo inválido.');
      lista.forEach((e) => { if (!estilos.some((x) => x.id === e.id)) estilos.push(e); });
      save('estudio.estilos', estilos);
      renderEstilos();
    } catch (e) { alert('Não consegui importar: ' + e.message); }
  });
}

// exposto para testes
window.__estudio = { montarLinhaDoTempo, montar, get projeto() { return projeto; }, set projeto(p) { projeto = p; }, ESTILO_PADRAO };

iniciar();
