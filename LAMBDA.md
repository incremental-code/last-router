# Lambda Support for Last Router

AWS Lambda compatibility for last-router filesystem-based routing. Deploy your last-router apps to AWS Lambda with API Gateway.

## How It Works

The Lambda handler:
- Takes API Gateway proxy events
- Routes to the correct `api.js` and `page.js` handlers
- Renders pages with last-act
- Returns proper Lambda responses

Same routing logic works everywhere — dev server, production, Lambda.

## Usage

### 1. Add Lambda Handler to Your Service

In `src/index.js`:

```javascript
import { createLambdaHandler } from '@incremental-code/last-router/lambda';

export const handler = createLambdaHandler({
    base: './src',
});
```

### 2. Configure CDK

In your service's `cdk/stacks/service-stack.ts`:

```typescript
const lambdaFunction = new lambda.Function(this, 'Handler', {
  runtime: lambda.Runtime.NODEJS_18_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset(path.join(__dirname, '../../src')),
  // ... rest of config
});
```

CDK automatically deploys your `src/` directory to Lambda.

### 3. Deploy

```bash
cd cdk
npm run deploy:dev
```

## API Routes

### API-Only Routes (no page.js)

Return JSON directly:

```
src/api/users/api.js → /api/users → JSON response
```

### Rendered Pages (with page.js)

Return HTML with server-rendered component:

```
src/posts/page.js → /posts → HTML response
src/posts/api.js  → (optional data)
```

### Path Parameters

```
src/[id]/page.js → /:id
src/blog/[slug]/api.js → /blog/:slug (JSON)
```

## API and Page Signatures

### api.js

```javascript
// Return a plain value
export default async function ({ params, query, body, headers }) {
    return {
        greeting: `Hello, ${params.username}!`
    };
}

// Or stream updates (SSR drains first second)
export default async function* ({ params }) {
    yield { status: 'loading' };
    const data = await fetchData(params.id);
    yield { ...data, status: 'ready' };
}
```

### page.js

```javascript
import { createElement } from '@incremental-code/last-act';

export default function Post({ params, body }) {
    return createElement('div', undefined,
        createElement('h1', undefined, body.title),
        createElement('p', undefined, body.content),
    );
}
```

## Lambda-Specific Features

### Health Check

```
GET /health → { "status": "ok" }
```

Always available.

### Environment Variables

Set via CDK:

```typescript
environment: {
    ENVIRONMENT: props.environment,
    DATABASE_URL: 'your-db-url',
}
```

Access in api.js:

```javascript
const dbUrl = process.env.DATABASE_URL;
```

### Redirects

```javascript
import { Redirect } from '@incremental-code/last-router/lambda';

export default function ({ apiRes }) {
    if (!authorized) {
        apiRes.redirect('/login');
    }
    return { data: 'ok' };
}
```

### Set Cookies

```javascript
export default function ({ apiRes }) {
    apiRes.setCookie('session', 'abc123', {
        httpOnly: true,
        sameSite: 'lax',
        path: '/'
    });
    return { status: 'ok' };
}
```

### Flash Messages

```javascript
export default function ({ apiRes }) {
    apiRes.flash('success', 'Item created!');
    apiRes.redirect('/items');
}
```

## Limitations

1. **No Streaming**: Lambda responses aren't true streaming, so async iterables are drained for SSR
2. **Base64 Encoding**: Binary responses are automatically base64 encoded
3. **File Uploads**: Multipart handling not yet implemented for Lambda
4. **Cold Starts**: Initial request takes ~1-2s (standard Lambda behavior)

## Monitoring

View Lambda logs:

```bash
# Auth service
aws logs tail /aws/lambda/auth-dev-AuthHandler --follow

# Blog service
aws logs tail /aws/lambda/blog-dev-BlogHandler --follow
```

## Troubleshooting

**Module not found errors:**
- Ensure last-router and last-act are in dependencies
- Check that `base` path in handler matches your src location

**500 errors:**
- Check CloudWatch logs
- Ensure api.js exports default function
- Check page.js returns valid JSX/elements

**Routes not matching:**
- Check filesystem layout matches API paths
- Ensure all segments have corresponding directories
- Use `/health` to verify Lambda is running

## References

- [API Gateway Proxy Integration](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html)
- [Lambda Handler Interface](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html)
