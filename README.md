# 💌 Date Invite — Serverless AI App

A personalized date invite generator powered by Claude or OpenAI, deployed on AWS.

## Project Structure

```
invite_Claude-exercise/
├── site/                  # Static frontend (all three pages)
│   ├── index.html         # Invite generator form (your view)
│   ├── invite.html        # Recipient's invite page (shareable)
│   ├── yes.html           # Celebration page
│   ├── styles.css         # Responsive CSS — desktop + mobile
│   ├── app.js             # Frontend logic
│   └── config.js          # API URL config (injected at build time)
├── lambda/
│   ├── generate.js        # AI proxy — routes to Claude or OpenAI
│   └── package.json
├── amplify.yml            # Option A: Amplify build spec
└── README.md
```

---

## Option A — AWS Amplify

### Prerequisites
- AWS account
- GitHub repo with this code pushed
- `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`

### Step 1 — Deploy the Lambda function

The Lambda needs to exist before Amplify can reference its URL.

1. Zip the lambda folder:
   ```bash
   cd lambda && npm install && zip -r ../lambda.zip . && cd ..
   ```
2. In AWS Console → Lambda → **Create function**
   - Runtime: Node.js 22.x
   - Upload `lambda.zip`
   - Handler: `generate.handler`
3. Add environment variables to the Lambda:
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `OPENAI_API_KEY` = your OpenAI key
   - `SES_FROM_EMAIL` = verified SES sender, e.g. `invites@jaycloud.net`
   - `SES_REGION` = SES region, e.g. `ap-northeast-1`
   - `SES_CALENDAR_TIMEZONE` = optional default timezone, e.g. `Europe/London`

For calendar invites, verify your sender domain in Amazon SES, enable production access, and give the Lambda execution role `ses:SendRawEmail`. When a recipient clicks **Yes!**, Lambda sends the sender an email with an `.ics` calendar invite attachment.

### Step 2 — Create an API Gateway

1. AWS Console → API Gateway → **Create API** → HTTP API
2. Add integration → Lambda → select your function
3. Route: `POST /generate`
4. Deploy the API and copy the **Invoke URL**
   - It looks like: `https://abc123.execute-api.us-east-1.amazonaws.com`

### Step 3 — Connect to Amplify

1. AWS Console → Amplify → **New app** → Host web app
2. Connect your GitHub repo
3. Amplify detects `amplify.yml` automatically
4. Under **Environment variables**, add:
   - `API_GATEWAY_URL` = the Invoke URL from Step 2
5. Save and deploy

### Step 4 — Done

Amplify builds the site, injects the API URL into `config.js`, and publishes to a live URL like `https://main.abc123.amplifyapp.com`.

Every `git push` to your connected branch triggers an automatic redeploy.

---

## How the AI generation works

1. You fill in the form (your email, recipient name, activity, date, optional note)
2. Frontend POSTs to `/generate` on your API Gateway
3. Lambda uses OpenAI first, then falls back to Claude if needed
4. A shareable `/invite.html?...` link is generated with the message and sender email encoded in the URL
5. When the recipient clicks **Yes!**, `/yes.html` POSTs an `acceptInvite` request and Lambda emails the sender an `.ics` calendar invite through Amazon SES

### Models used
| Provider | Model | Why |
|---|---|---|
| Claude | `claude-haiku-4-5` | Fastest + cheapest Anthropic model |
| OpenAI | `gpt-4o-mini` | Fastest + cheapest OpenAI model |

---

## Local development

Set `apiUrl` in `site/config.js` to your API Gateway URL, then open `site/index.html` in a browser or serve with:

```bash
npx serve site
```
