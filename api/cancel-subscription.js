// /api/cancel-subscription.js
// Cancela (ou reativa) a assinatura do barbeiro no Stripe, mantendo o acesso
// até o fim do período já pago (cancel_at_period_end).
//
// Segurança: antes de mexer em qualquer coisa, verificamos junto ao Supabase
// (usando o token de login de quem fez a requisição, respeitando as regras
// de segurança do banco) que essa pessoa é realmente a dona do negócio.

const SUPABASE_URL = 'https://fsgyltsicqthxqoulufd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_5WVdzdHJKBtcpOrUhcxraQ_XEsOZ_b2';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { negocioId, reativar } = req.body || {};
  const authHeader = req.headers.authorization;

  if (!negocioId || !authHeader) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  try {
    // Confirma que quem está pedindo é realmente o dono deste negócio
    // (a busca só retorna algo se o RLS do Supabase permitir, usando o
    // token de login de quem chamou — não confiamos apenas no negocioId enviado)
    const checkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/assinaturas?negocio_id=eq.${negocioId}&select=stripe_subscription_id`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader } }
    );
    const rows = await checkResp.json();

    if (!checkResp.ok || !Array.isArray(rows) || !rows.length) {
      return res.status(403).json({ error: 'Não autorizado ou assinatura não encontrada' });
    }

    const subId = rows[0].stripe_subscription_id;
    if (!subId) {
      return res.status(400).json({ error: 'Nenhuma assinatura ativa encontrada para cancelar' });
    }

    // Se essa assinatura estiver sob controle de um "agendamento de troca de
    // plano" (subscription schedule, criado por um downgrade pendente), o
    // Stripe não deixa mexer direto no cancelamento — precisa liberar esse
    // agendamento antes, o que devolve a assinatura ao modo normal mantendo
    // o plano/preço atual dela intactos.
    const subResp = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    const subData = await subResp.json();
    if (subResp.ok && subData.schedule) {
      const releaseResp = await fetch(`https://api.stripe.com/v1/subscription_schedules/${subData.schedule}/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      });
      if (!releaseResp.ok) {
        const releaseErr = await releaseResp.json();
        console.error('Erro ao liberar schedule:', releaseErr);
        return res.status(400).json({ error: 'Não foi possível liberar o agendamento de troca de plano pendente. Tente novamente em instantes.' });
      }
    }

    const params = new URLSearchParams();
    params.append('cancel_at_period_end', reativar ? 'false' : 'true');

    const stripeResp = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await stripeResp.json();

    if (!stripeResp.ok) {
      console.error('Erro do Stripe:', data);
      return res.status(400).json({ error: data.error?.message || 'Erro ao atualizar assinatura' });
    }

    return res.status(200).json({ ok: true, cancelAtPeriodEnd: data.cancel_at_period_end });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
