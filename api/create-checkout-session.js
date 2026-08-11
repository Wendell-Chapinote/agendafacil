// /api/create-checkout-session.js
// Cria uma sessão de checkout do Stripe para assinatura mensal.
// A chave secreta do Stripe NUNCA aparece no navegador — só aqui, no servidor.

const PRICE_IDS = {
  basico: 'price_1U32viDGnB6UpcSglVWqGtyg',
  pro: 'price_1U32wDDGnB6UpcSg2anvpXIn',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { negocioId, plano } = req.body || {};

  if (!negocioId || !plano) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const priceId = PRICE_IDS[plano];
  if (!priceId) {
    return res.status(400).json({ error: 'Plano inválido' });
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;

  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', `${origin}/#painel?checkout=sucesso`);
  params.append('cancel_url', `${origin}/#painel?checkout=cancelado`);
  params.append('metadata[negocio_id]', negocioId);
  params.append('metadata[plano]', plano);

  try {
    const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
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
      return res.status(400).json({ error: data.error?.message || 'Erro ao criar checkout' });
    }

    return res.status(200).json({ url: data.url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
