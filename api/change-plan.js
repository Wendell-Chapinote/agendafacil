// /api/change-plan.js
// Troca de plano da assinatura:
//  - Upgrade (Básico -> Pro): aplica na hora, cobrando o valor proporcional
//    aos dias restantes do ciclo atual (o Stripe calcula isso sozinho).
//  - Downgrade (Pro -> Básico): só entra em vigor no fim do período já
//    pago, usando "Subscription Schedule" do Stripe — o cliente continua
//    com os recursos Pro até lá, sem estorno e sem cobrança extra.
//
// Segurança: confirmamos que quem pediu é realmente dono do negócio,
// usando o token de login da pessoa contra as regras do Supabase (RLS) —
// não confiamos apenas no negocioId enviado pelo navegador.

const SUPABASE_URL = 'https://fsgyltsicqthxqoulufd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_5WVdzdHJKBtcpOrUhcxraQ_XEsOZ_b2';

const PRICE_IDS = {
  basico: 'price_1U32viDGnB6UpcSglVWqGtyg',
  pro: 'price_1U32wDDGnB6UpcSg2anvpXIn',
};

async function stripeFetch(path, method, params) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (params) opts.body = params.toString();
  const resp = await fetch(`https://api.stripe.com/v1${path}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || 'Erro na chamada ao Stripe');
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { negocioId, novoPlano } = req.body || {};
  const authHeader = req.headers.authorization;

  if (!negocioId || !novoPlano || !authHeader) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }
  if (!PRICE_IDS[novoPlano]) {
    return res.status(400).json({ error: 'Plano inválido' });
  }

  try {
    // 1. Confirma que quem pediu é realmente o dono deste negócio
    const checkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/assinaturas?negocio_id=eq.${negocioId}&select=stripe_subscription_id,plano`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader } }
    );
    const rows = await checkResp.json();
    if (!checkResp.ok || !Array.isArray(rows) || !rows.length) {
      return res.status(403).json({ error: 'Não autorizado ou assinatura não encontrada' });
    }

    const subId = rows[0].stripe_subscription_id;
    const planoAtual = rows[0].plano;
    if (!subId) return res.status(400).json({ error: 'Nenhuma assinatura ativa encontrada' });
    if (planoAtual === novoPlano) return res.status(400).json({ error: 'Você já está nesse plano' });

    const novoPriceId = PRICE_IDS[novoPlano];

    // 2. Busca a assinatura atual no Stripe
    const sub = await stripeFetch(`/subscriptions/${subId}`, 'GET');
    const itemId = sub.items.data[0].id;

    const isUpgrade = novoPlano === 'pro' && planoAtual === 'basico';

    if (isUpgrade) {
      // Se havia um downgrade agendado pendente, cancela o agendamento primeiro
      if (sub.schedule) {
        try { await stripeFetch(`/subscription_schedules/${sub.schedule}/release`, 'POST'); } catch (e) { /* segue mesmo se falhar */ }
      }

      // Upgrade imediato, cobrando o valor proporcional dos dias restantes
      const params = new URLSearchParams();
      params.append('items[0][id]', itemId);
      params.append('items[0][price]', novoPriceId);
      params.append('proration_behavior', 'always_invoice');
      await stripeFetch(`/subscriptions/${subId}`, 'POST', params);

      return res.status(200).json({ ok: true, tipo: 'upgrade' });
    } else {
      // Downgrade agendado para o fim do período atual já pago
      let scheduleId = sub.schedule;

      if (!scheduleId) {
        const params = new URLSearchParams();
        params.append('from_subscription', subId);
        const schedule = await stripeFetch('/subscription_schedules', 'POST', params);
        scheduleId = schedule.id;
      }

      const scheduleAtual = await stripeFetch(`/subscription_schedules/${scheduleId}`, 'GET');
      const faseAtual = scheduleAtual.phases[0];

      const params = new URLSearchParams();
      params.append('end_behavior', 'release');
      // fase 1: continua no plano atual até o fim do período já pago
      params.append('phases[0][start_date]', faseAtual.start_date);
      params.append('phases[0][end_date]', faseAtual.end_date);
      params.append('phases[0][items][0][price]', faseAtual.items[0].price);
      // fase 2: passa a cobrar o novo plano a partir dali, indefinidamente
      params.append('phases[1][items][0][price]', novoPriceId);
      params.append('phases[1][iterations]', '1');

      await stripeFetch(`/subscription_schedules/${scheduleId}`, 'POST', params);

      return res.status(200).json({ ok: true, tipo: 'downgrade', vigorApartirDe: faseAtual.end_date });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
