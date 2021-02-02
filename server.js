require('isomorphic-fetch');
const dotenv = require('dotenv');
const Koa = require('koa');
const next = require('next');
const { default: createShopifyAuth, initializeShopifyKoaMiddleware } = require('@shopify/koa-shopify-auth');
const { verifyRequest } = require('@shopify/koa-shopify-auth');
const session = require('koa-session');
const { default: Shopify, ApiVersion } = require('@shopify/shopify-api');
const getSubscriptionUrl = require('./server/getSubscriptionUrl');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');

dotenv.config();

Shopify.Context.initialize({
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
  SCOPES: process.env.SCOPES.split(","),
  HOST_NAME: process.env.HOST.replace(/https:\/\//, ""),
  API_VERSION: ApiVersion.October20,
  IS_EMBEDDED_APP: true,
  SESSION_STORAGE: new Shopify.Session.MemorySessionStorage(),
});
initializeShopifyKoaMiddleware(Shopify.Context);

const port = parseInt(process.env.PORT, 10) || 3000;
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = new Koa();
  const router = new Router();
  server.use(session({ secure: true, sameSite: 'none' }, server));
  server.keys = [Shopify.Context.API_SECRET_KEY];

  server.use(
    createShopifyAuth({
      async afterAuth(ctx) {
        const { shop, accessToken } = ctx.state.shopify;

        const registration = await Shopify.Webhooks.Registry.register({
          shop,
          accessToken,
          path: '/webhooks',
          topic: 'PRODUCTS_CREATE',
          apiVersion: ApiVersion.October20,
          webhookHandler: (topic, shop, _body) => {
            console.log(`Received webhook: { topic: ${topic}, domain: ${shop} }`);
          },
        });

        if (registration.success) {
          console.log('Successfully registered webhook!');
        } else {
          console.log('Failed to register webhook', registration.result);
        }

        const returnUrl = `https://${Shopify.Context.HOST_NAME}?shop=${shop}`;
        const subscriptionUrl = await getSubscriptionUrl(accessToken, shop, returnUrl);
        ctx.redirect(subscriptionUrl);
      },
    }),
  );

  router.post('/webhooks', bodyParser(), async (ctx) => {
    const response = await Shopify.Webhooks.Registry.process({
      headers: ctx.req.headers,
      body: ctx.request.rawBody,
    });

    console.log(`Webhook processed with status code ${response.statusCode}`);
    ctx.statusCode = response.statusCode;
  });

  server.use(async (ctx, next) => {
    if (ctx.method === 'POST' && ctx.path === '/graphql') {
      await Shopify.Utils.graphqlProxy(ctx.req, ctx.res);
    } else {
      await next();
    }
  });

  router.get('(.*)', verifyRequest(), async (ctx) => {
    await handle(ctx.req, ctx.res);
    ctx.respond = false;
    ctx.res.statusCode = 200;
  });
  server.use(router.allowedMethods());
  server.use(router.routes());

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
