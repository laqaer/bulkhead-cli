import { describe, it, expect } from "vitest";
import {
  REDACTED,
  redact,
  redactSecrets,
  relativizePaths,
  isSecretName,
  isHighEntropyToken,
} from "../src/redact.js";

/**
 * Redaction guards two failure modes, and both are pinned here: a secret
 * printed into a receipt that gets pasted into a public PR (false negative),
 * and a receipt so over-masked that a reviewer can't read the commands
 * (false positive). The fixtures are fake, shaped like real credentials.
 */

// Assembled at runtime so no literal credential-shaped string sits in the source.
const fake = (...parts: string[]) => parts.join("");
const ANTHROPIC = fake("sk-ant-", "api03-", "Zx9Qm2Lk7Rt5Vb1Nc8Hj3Gf6Dd4Ss0Aa-Pp_Oo9Ii8Uu7");
const OPENAI = fake("sk-", "proj-", "4fGh7Jk2Lm9Np3Qr6St8Uv1Wx5Yz0Ab");
const GH_PAT = fake("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const GH_OAUTH = fake("gho_", "16C7e42F292c6912E7710c838347Ae178B4a");
const GH_FINE = fake("github_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789");
const AWS_ID = fake("AKIA", "IOSFODNN7EXAMPLE");
const SLACK = fake("xoxb-", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx");
const JWT = fake(
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  ".",
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0",
  ".",
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
);
const RANDOM_B64 = fake("q8Vd2XkP9sLm4TzR7wYb1NcJ5HfG3aQe", "Ku6Zo0Ix");

const SECRETS: Array<[string, string, string]> = [
  ["Anthropic key", `curl -H "x-api-key: ${ANTHROPIC}" https://api.anthropic.com`, ANTHROPIC],
  ["OpenAI key", `OPENAI=${OPENAI} node run.js`, OPENAI],
  ["GitHub PAT", `git clone https://${GH_PAT}@github.com/acme/api.git`, GH_PAT],
  ["GitHub OAuth token", `gh auth login --with-token <<< ${GH_OAUTH}`, GH_OAUTH],
  ["GitHub fine-grained PAT", `echo ${GH_FINE}`, GH_FINE],
  ["AWS access key id", `aws configure set aws_access_key_id ${AWS_ID}`, AWS_ID],
  ["Slack bot token", `curl -d token=${SLACK} https://slack.com/api/chat.postMessage`, SLACK],
  ["JWT", `curl -H "X-Auth: ${JWT}" https://api.example.com`, JWT],
  ["Bearer header", `curl -H "Authorization: Bearer abc123def456ghi789" https://x.io`, "abc123def456ghi789"],
  ["Authorization token header", `curl -H "Authorization: token 9f8e7d6c5b4a" https://api.github.com`, "9f8e7d6c5b4a"],
  ["API_KEY=value", "API_KEY=hunter2hunter2 npm start", "hunter2hunter2"],
  ["GITHUB_TOKEN=value", `GITHUB_TOKEN=${GH_PAT} gh pr create`, GH_PAT],
  ["fused PGPASSWORD", "PGPASSWORD=correcthorse psql -h db", "correcthorse"],
  ["lowercase password=", "mysql --user=root --password=s3cr3t!", "s3cr3t!"],
  ["DB_PASS=", "DB_PASS=letmein ./migrate", "letmein"],
  ["MYSQL_PWD=", "MYSQL_PWD='quoted value' mysql", "quoted value"],
  ["client_secret=", "curl -d client_secret=abcDEF123 https://auth", "abcDEF123"],
  ["camelCase apiKey=", "node cli.js apiKey=zzTop99", "zzTop99"],
  ["JSON api_key", `curl -d '{"api_key": "live_abc_123"}' https://x.io`, "live_abc_123"],
  ["YAML password", "echo \"password: 'opensesame'\" >> config.yml", "opensesame"],
  ["--token value", "vercel deploy --token abcd1234efgh", "abcd1234efgh"],
  ["--password value", "psql --password swordfish", "swordfish"],
  ["URL password", "psql postgres://admin:pa55word@db.internal:5432/app", "pa55word"],
  ["URL token user", `git push https://x-access-token:${GH_OAUTH}@github.com/acme/api`, GH_OAUTH],
  ["long random string", `export SESSION=${RANDOM_B64}`, RANDOM_B64],
  ["Stripe secret key", `curl -u ${fake("sk_live_", "51HqLyjWDarjtT1zdp7dc")}: https://api.stripe.com`, fake("sk_live_", "51HqLyjWDarjtT1zdp7dc")],
];

describe("redactSecrets: no false negatives on known credential shapes", () => {
  for (const [name, input, secret] of SECRETS) {
    it(`masks ${name}`, () => {
      const out = redactSecrets(input);
      expect(out, out).not.toContain(secret);
      expect(out).toContain(REDACTED);
    });
  }

  it("masks a PEM private key block entirely", () => {
    const pem = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU", "-----END OPENSSH PRIVATE KEY-----"].join("\n");
    const out = redactSecrets(`cat > id_ed25519 <<EOF\n${pem}\nEOF`);
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU");
    expect(out).toContain("cat > id_ed25519");
  });

  it("keeps the recognisable prefix so a reader knows what was there", () => {
    expect(redactSecrets(`echo ${GH_PAT}`)).toBe(`echo ghp_${REDACTED}`);
    expect(redactSecrets(`x ${ANTHROPIC}`)).toBe(`x sk-ant-${REDACTED}`);
    expect(redactSecrets(`id ${AWS_ID}`)).toBe(`id AKIA${REDACTED}`);
    expect(redactSecrets("API_KEY=abc123 run")).toBe(`API_KEY=${REDACTED} run`);
    expect(redactSecrets("postgres://admin:pw1@db/app")).toBe(`postgres://admin:${REDACTED}@db/app`);
  });

  it("is idempotent", () => {
    for (const [, input] of SECRETS) {
      const once = redactSecrets(input);
      expect(redactSecrets(once)).toBe(once);
    }
  });
});

describe("redactSecrets: no over-redaction of ordinary text", () => {
  const ORDINARY = [
    "All tests pass",
    "git push --force origin main",
    "git push --force-with-lease origin feature/login",
    "npm install left-pad",
    "pnpm test -- --reporter=verbose",
    "rm -rf node_modules dist .next",
    "The token expired, so I refreshed it.",
    "Bearer authentication is required for this endpoint",
    "setxkbmap -layout us keyboard=us",
    "monkey=banana bypass=true passes=3 KEYBOARD=us",
    "sk-learn is not a thing, scikit-learn is",
    'curl -H "Authorization: Bearer $RAILWAY_TOKEN" https://backboard.railway.app/graphql/v2',
    "API_KEY=$API_KEY npm start",
    'TOKEN="$(cat .token)" ./deploy.sh',
    "DATABASE_URL=postgres://localhost/dev npm run migrate",
    "ssh://git@github.com/acme/api.git",
    "git@github.com:acme/api.git",
    "https://github.com/acme/api/pull/42",
    "git checkout 3f9a2c1b7d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a",
    "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "session 550e8400-e29b-41d4-a716-446655440000",
    "packages/core/src/guards/blocked-commands.ts",
    "src/components/UserProfile2/index.tsx",
    "useEffectHookDependencyArrayWarningMessage",
    "getUser2FactorAuthenticationSettingsV3ForAdmin",
    "test_should_render_component_with_props_2",
    "vitest run src/checkout.test.ts -t applies_a_percentage_discount_code_2024",
    "kubectl get pods -n production --sort-by=.metadata.creationTimestamp",
    "sort --key 2 data.txt",
    "PUBLIC_URL=https://acme.dev npm run build",
    "npx prisma migrate dev --name add_users",
    'psql "$DATABASE_URL" -c "DELETE FROM sessions WHERE expires_at < now();"',
  ];
  for (const text of ORDINARY) {
    it(`leaves "${text.slice(0, 50)}" alone`, () => {
      expect(redactSecrets(text)).toBe(text);
    });
  }
});

describe("redaction stays linear on hostile input", () => {
  // Redaction runs inside the PreToolUse hook on agent-controlled text, and a
  // hook that times out lets the tool call through. Each of these shapes made
  // an earlier revision quadratic (seconds at 40 KB, minutes at 200 KB).
  const SHAPES: Array<[string, string]> = [
    ["one long word", "x".repeat(60_000)],
    ["dotted identifiers", "ab_cd.".repeat(10_000)],
    ["dash-separated words", "--a-".repeat(15_000)],
    ["base64-ish run", "Ab1+".repeat(15_000)],
    ["lowercase path segment", "Ab1/" + "a".repeat(60_000) + "1"],
    ["equals run", "=".repeat(60_000)],
    ["colon pairs", "a: ".repeat(20_000)],
    ["unterminated PEM headers", "-----BEGIN RSA PRIVATE KEY-----".repeat(2_000)],
  ];
  for (const [name, input] of SHAPES) {
    it(`handles ${name} (${input.length} chars) quickly`, () => {
      const t = performance.now();
      redact(input, { repoRoot: "/home/dev/app", homeDir: "/home/dev" });
      expect(performance.now() - t).toBeLessThan(500);
    });
  }
});

describe("isSecretName", () => {
  it("matches credential names by word, not by substring", () => {
    for (const n of ["API_KEY", "apiKey", "GITHUB_TOKEN", "db-password", "PGPASSWORD", "MYSQL_PWD", "client_secret", "SECRET", "passwd", "accessToken"]) {
      expect(isSecretName(n), n).toBe(true);
    }
    for (const n of ["keyboard", "monkey", "bypass", "passes", "KEYBOARD", "DATABASE_URL", "PUBLIC_URL", "tokenizer", "secretary"]) {
      expect(isSecretName(n), n).toBe(false);
    }
  });
});

describe("isHighEntropyToken", () => {
  it("flags random tokens (a fixed sample of 30 random bytes, base64url)", () => {
    const sample = [
      "h3-LzTQl0LNBiSwM85JtYu3AT3Np_FXaosAsHzTF",
      "K3k61iZL5iHPlADIezsno_UXYb6NI9qgFVmDYas0",
      "RCcUXCJ5KGsju74MsrfcfBVZpCX9XecXew0YbkTS",
      "wbzXxx8uaP-drhlV_vWmAw6bfosxOwGv1eHmDmfC",
      "kXX9bEXAiFFqVw89e4MKXVpGoD-KqM1wQ77jhi6q",
      "QMmNrH2VFCMUkpEv_uhXrzQwoi-fGWVdP_f0BIBK",
      "YtLL6sDR6Q6WNz7GIYib3lPiNc-j8ja5nKIWYPc1",
      "MX2ml1-p7iipUgZLav9JBVELh1crUjP-6mPQQxnV",
    ];
    for (const t of sample) {
      expect(isHighEntropyToken(t), t).toBe(true);
      expect(redactSecrets(`export SESSION_ID=${t}`)).not.toContain(t);
    }
  });

  it("flags random tokens and spares hashes, UUIDs, identifiers and paths", () => {
    expect(isHighEntropyToken(RANDOM_B64)).toBe(true);
    expect(isHighEntropyToken("3f9a2c1b7d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a")).toBe(false);
    expect(isHighEntropyToken("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(isHighEntropyToken("useEffectHookDependencyArrayWarningMessage")).toBe(false);
    expect(isHighEntropyToken("src/components/UserProfile2/index")).toBe(false);
    expect(isHighEntropyToken("short1A")).toBe(false);
  });
});

describe("relativizePaths", () => {
  it("prints paths under the repo repo-relative and the root itself as .", () => {
    const root = "/home/dev/acme-app";
    const opts = { repoRoot: root, homeDir: "/home/dev" };
    expect(relativizePaths(`Write ${root}/src/app.ts`, opts)).toBe("Write src/app.ts");
    expect(relativizePaths(`cd ${root} && ls`, opts)).toBe("cd . && ls");
    expect(relativizePaths(`cat ${root}/.env`, opts)).toBe("cat .env");
    expect(relativizePaths(`"${root}/a b.txt"`, opts)).toBe('"a b.txt"');
  });

  it("prints other paths under home as ~ and leaves unrelated paths alone", () => {
    const opts = { repoRoot: "/home/dev/acme-app", homeDir: "/home/dev" };
    expect(relativizePaths("rm -rf /home/dev/backups", opts)).toBe("rm -rf ~/backups");
    expect(relativizePaths("ls /home/dev", opts)).toBe("ls ~");
    expect(relativizePaths("rm -rf /var/lib/postgresql/data", opts)).toBe("rm -rf /var/lib/postgresql/data");
    // A sibling whose name merely starts with the root is not under it.
    expect(relativizePaths("ls /home/dev/acme-app-old/x", opts)).toBe("ls ~/acme-app-old/x");
    // The root embedded deeper in another path is not the root.
    expect(relativizePaths("ls /mnt/home/dev/acme-app/x", opts)).toBe("ls /mnt/home/dev/acme-app/x");
  });

  it("redact() does both", () => {
    const out = redact("API_KEY=abc123 node /home/dev/acme-app/scripts/seed.js", {
      repoRoot: "/home/dev/acme-app",
      homeDir: "/home/dev",
    });
    expect(out).toBe(`API_KEY=${REDACTED} node scripts/seed.js`);
  });
});
