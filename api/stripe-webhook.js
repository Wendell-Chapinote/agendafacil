// /api/stripe-webhook.js
// Recebe notificações do Stripe (pagamento aprovado, falhou, cancelado)
// e atualiza a tabela "assinaturas" no Supabase usando a chave de serviço
// (que também nunca aparece no navegador — só aqui, no servidor).

const crypto = require('crypto');

// Precisamos do corpo "cru" da requisição para verificar a assinatura do Stripe
module.exports.config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verificarAssinaturaStripe(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function atualizarAssinatura(campoFiltro, valorFiltro, campos) {
  const url = `${SUPABASE_URL}/rest/v1/assinaturas?${campoFiltro}=eq.${valorFiltro}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(campos),
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error('Erro ao atualizar assinatura no Supabase:', text);
  }
}

function proximaData(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().split('T')[0];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!verificarAssinaturaStripe(raw, sig, secret)) {
    return res.status(400).json({ error: 'Assinatura inválida' });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return res.status(400).json({ error: 'JSON inválido' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const negocioId = session.metadata && session.metadata.negocio_id;
        const plano = session.metadata && session.metadata.plano;
        if (negocioId) {
          await atualizarAssinatura('negocio_id', negocioId, {
            status: 'ativo',
            plano: plano || null,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            proximo_vencimento: proximaData(30),
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          await atualizarAssinatura('stripe_subscription_id', subId, {
            status: 'ativo',
            proximo_vencimento: proximaData(30),
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          await atualizarAssinatura('stripe_subscription_id', subId, {
            status: 'atrasado',
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await atualizarAssinatura('stripe_subscription_id', sub.id, {
          status: 'cancelado',
          updated_at: new Date().toISOString(),
        });
        break;
      }
      default:
        break;
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
