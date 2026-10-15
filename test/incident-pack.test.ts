import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  BUILTIN_BLOCKED_COMMANDS,
  STRICT_PRESET_BLOCKED_COMMANDS,
  defaultPolicy,
  normalizePolicy,
} from "../src/policy.js";
import { STRICT_POLICY_YAML } from "../src/templates.js";
import { blockedCommandsGuard } from "../src/guards/blocked-commands.js";
import type { ToolCall } from "../src/types.js";

/**
 * Every shipped command rule added for the incident pack and the strict
 * preset, with commands it must deny and ordinary commands it must leave
 * alone. A positive must be denied by THAT rule (its message is asserted), so
 * a case that happens to be caught by some other rule does not count.
 *
 * The strict policy is loaded the way a real install loads it: from the YAML
 * `bulkhead init --preset strict` writes, through normalizePolicy.
 */
const def = defaultPolicy("/repo");
const strict = normalizePolicy(parseYaml(STRICT_POLICY_YAML), "/repo");

function bash(command: string): ToolCall {
  return { toolName: "Bash", toolInput: { command } };
}

interface RuleCases {
  message: string;
  deny: string[];
  allow: string[];
}

const GRAPHQL_DELETE = `-d '{"query":"mutation { deleteUser(id: 1) }"}'`;

const DEFAULT_RULES: RuleCases[] = [
  {
    message: "Unscoped SQL DELETE (no WHERE clause)",
    deny: [
      'psql "$DATABASE_URL" -c "DELETE FROM executives;"',
      'psql "$DATABASE_URL" -c "DELETE FROM executives"',
      "psql -c 'DELETE FROM \"Users\";'",
      'psql -c "DELETE FROM \\"Users\\""',
      "mysql -e 'DELETE FROM `users`'",
      'sqlite3 app.db "DELETE FROM public.users RETURNING *"',
      'psql -c "DELETE FROM ONLY users;"',
      "psql \"$DATABASE_URL\" <<'SQL'\nDELETE FROM users;\nSQL",
      'psql -c "DELETE FROM sessions WHERE id = 1; DELETE FROM audit_log;"',
    ],
    allow: [
      'psql "$DATABASE_URL" -c "DELETE FROM sessions WHERE expires_at < now();"',
      'psql -c "DELETE FROM \\"Users\\" WHERE id = 1"',
      "psql -c 'DELETE FROM \"Users\" WHERE id = 1'",
      "psql <<'SQL'\nDELETE FROM users\nWHERE id = 1;\nSQL",
      'mysql -e "DELETE FROM jobs ORDER BY id LIMIT 100"',
      'psql -c "DELETE FROM a USING b WHERE a.id = b.id"',
      'git commit -m "fix: delete from queue on ack"',
    ],
  },
  {
    message: "terraform destroy (tears down managed infrastructure)",
    deny: [
      "terraform destroy -auto-approve",
      "terraform -chdir=infra destroy",
      "terraform apply -auto-approve -destroy",
      "tofu destroy",
    ],
    allow: [
      "terraform plan",
      "terraform plan -destroy -out=tf.plan",
      "terraform apply tfplan",
      "cd terraform && terraform init && terraform validate",
    ],
  },
  {
    message: "pulumi destroy (tears down a stack's infrastructure)",
    deny: ["pulumi destroy --yes", "pulumi down -y"],
    allow: ["pulumi preview", "pulumi up --yes", "pulumi stack ls"],
  },
  {
    message: "GraphQL delete mutation sent to a remote API",
    deny: [
      `curl -X POST https://backboard.railway.app/graphql/v2 -H "Authorization: Bearer $RAILWAY_TOKEN" -d '{"query":"mutation { volumeDelete(volumeId: \\"vol_7f3a\\") }"}'`,
      `curl -X POST https://api.example.com/graphql ${GRAPHQL_DELETE}`,
      // No loopback host anywhere: $API_URL or a bare hostname may be production.
      `curl -X POST $API_URL ${GRAPHQL_DELETE}`,
      `curl api.example.com/graphql -d '{"query":"mutation { delete_users(where: {}) { affected_rows } }"}'`,
      `http POST https://api.example.com/graphql query='mutation { projectDelete(id: "p") }'`,
      `wget --post-data='{"query":"mutation { appDestroy(id: 1) }"}' https://api.example.com/graphql`,
      // A loopback name as a subdomain of a real host is not loopback.
      `curl http://localhost.evil.example/graphql ${GRAPHQL_DELETE}`,
    ],
    allow: [
      `curl -X POST http://localhost:4000/graphql ${GRAPHQL_DELETE}`,
      `curl -X POST http://127.0.0.1:8080/graphql ${GRAPHQL_DELETE}`,
      `curl -X POST http://[::1]:4000/graphql ${GRAPHQL_DELETE}`,
      `curl -X POST http://0.0.0.0:3000/graphql ${GRAPHQL_DELETE}`,
      `curl localhost:4000/graphql ${GRAPHQL_DELETE}`,
      `curl http://api.localhost:3000/graphql ${GRAPHQL_DELETE}`,
      `curl -X POST https://api.example.com/graphql -d '{"query":"mutation { createUser(name: \\"x\\") { id } }"}'`,
      `curl -X POST https://api.example.com/graphql -d '{"query":"query { users { id deletedAt } }"}'`,
    ],
  },
  {
    message: "Railway volume delete",
    deny: ["railway volume delete --volume vol_7f3a --yes"],
    allow: ["railway volume list", "railway up", "railway logs"],
  },
  {
    message: "Recursive S3 delete",
    deny: [
      "aws s3 rm s3://acme-prod-backups --recursive",
      "aws --profile prod s3 rm --recursive s3://acme-prod-backups",
    ],
    allow: [
      "aws s3 rm s3://acme/tmp/report.csv",
      "aws s3 ls s3://acme-prod-backups",
      "aws s3 cp dist s3://acme-site --recursive",
      "aws s3 sync build s3://acme-site",
    ],
  },
  {
    message: "S3 bucket force-remove (deletes every object)",
    deny: ["aws s3 rb s3://acme-prod-backups --force"],
    allow: ["aws s3 rb s3://empty-scratch-bucket", "aws s3 mb s3://new-bucket"],
  },
  {
    message: "RDS database delete",
    deny: [
      "aws rds delete-db-instance --db-instance-identifier prod --skip-final-snapshot",
      "aws --region us-east-1 rds delete-db-cluster --db-cluster-identifier prod",
    ],
    allow: [
      "aws rds describe-db-instances",
      "aws rds create-db-snapshot --db-instance-identifier prod --db-snapshot-identifier pre-migrate",
    ],
  },
  {
    message: "Kubernetes namespace delete",
    deny: [
      "kubectl delete namespace production",
      "kubectl --context prod delete ns production",
      "kubectl delete ns/staging",
    ],
    allow: [
      "kubectl get pods -n production",
      "kubectl delete pod web-1 -n production",
      "kubectl get ns",
    ],
  },
  {
    message: "Redis FLUSHALL/FLUSHDB (deletes every key)",
    deny: ["redis-cli -u $REDIS_URL FLUSHALL", "echo FLUSHDB | redis-cli", "valkey-cli flushall"],
    allow: ["redis-cli -u $REDIS_URL GET session:1", "redis-cli ping"],
  },
  {
    message: "MongoDB dropDatabase()",
    deny: ['mongosh "$MONGO_URL" --eval "db.dropDatabase()"'],
    allow: ['mongosh "$MONGO_URL" --eval "db.users.countDocuments()"'],
  },
  {
    message: "Supabase reset of a remote database",
    deny: ["supabase db reset --linked", "supabase db reset --db-url postgres://u:p@db.example.com/postgres"],
    allow: ["supabase db reset", "supabase db push --linked", "supabase start"],
  },
  {
    message: "GitHub repository delete",
    deny: ["gh repo delete acme/api --yes"],
    allow: ["gh repo view acme/api", "gh repo clone acme/api", "gh pr create --fill"],
  },
  {
    message: "Heroku Postgres reset",
    deny: ["heroku pg:reset DATABASE_URL --app acme --confirm acme"],
    allow: ["heroku pg:info --app acme", "heroku logs --tail -a acme"],
  },
  {
    message: "Fly.io volume destroy",
    deny: ["fly volumes destroy vol_123 -y", "flyctl volumes delete vol_123", "fly vol destroy vol_123"],
    allow: ["fly volumes list", "fly deploy", "flyctl status"],
  },
  {
    message: "Cloud SQL instance delete",
    deny: ["gcloud sql instances delete prod-db", "gcloud beta sql instances delete prod-db --quiet"],
    allow: ["gcloud sql instances describe prod-db", "gcloud sql instances list"],
  },
  {
    message: "Recursive delete of a Windows drive root (rmdir/rd /s)",
    deny: [
      "rmdir /s /q d:\\",
      "rd /s /q C:\\",
      "rmdir /q /s c:/",
      "rmdir /s/q D:\\",
      "rmdir d:\\ /s /q",
      'rmdir /s /q "d:\\"',
      'cmd /c "rmdir /s /q d:\\"',
      "echo cleaning && rmdir /s /q d:\\",
    ],
    allow: [
      // Only the bare root matches: a folder on the drive is ordinary cleanup.
      "rmdir /s /q build",
      "rmdir /s /q .\\dist",
      "rmdir /s /q d:\\cache",
      "rd /s /q C:\\Users\\me\\AppData\\Local\\Temp\\build",
      // Without /s, rmdir only removes an empty directory.
      "rmdir d:\\",
      "dir d:\\",
      "mkdir d:\\backup",
    ],
  },
  {
    message: "Recursive delete of a Windows drive root (Remove-Item -Recurse)",
    deny: [
      "Remove-Item -Recurse -Force D:\\",
      "Remove-Item -Path 'D:\\' -Recurse -Force",
      "remove-item d:/ -r -force",
      'Remove-Item -LiteralPath "C:\\" -Recurse',
    ],
    allow: [
      "Remove-Item -Recurse -Force .\\dist",
      "Remove-Item D:\\cache -Recurse",
      "Remove-Item -Force D:\\notes.txt",
      "Get-ChildItem D:\\ -Recurse",
    ],
  },
];

const STRICT_RULES: RuleCases[] = [
  {
    message: "git reset --hard (discards uncommitted work)",
    deny: [
      "git reset --hard HEAD~3",
      "git reset HEAD~1 --hard",
      "git -C packages/core reset --hard",
      "git stash && git reset --hard origin/main",
    ],
    allow: [
      "git reset --soft HEAD~1",
      "git reset HEAD src/app.ts",
      "git reset --mixed HEAD~1",
      'git commit -m "reset --hard behaviour"',
    ],
  },
  {
    message: "git clean -f (deletes untracked files)",
    deny: ["git clean -fdx", "git clean -xdf", "git clean -fd", "git clean -f", "git clean --force -d"],
    allow: ["git clean -n", "git clean -fdn", "git clean -f --dry-run", "git status --short"],
  },
  {
    message: "Force-push without --force-with-lease",
    deny: [
      "git push --force origin feature/login",
      "git push -f origin feature/login",
      "git push -uf origin feature/login",
      "git push origin feature/login --force",
      "git push origin +feature/login",
    ],
    allow: [
      "git push --force-with-lease origin feature/login",
      "git push --force-if-includes --force-with-lease origin feature/login",
      "git push -u origin feature/login",
      "git push origin feature/login --follow-tags",
      "git push origin fix-foo",
    ],
  },
  {
    message: "drizzle-kit push --force (skips data-loss prompts)",
    deny: ["npx drizzle-kit push --force", "drizzle-kit push:pg --force"],
    allow: ["npx drizzle-kit push", "npx drizzle-kit generate"],
  },
  {
    message: "prisma migrate reset (drops the database)",
    deny: ["npx prisma migrate reset --force", "pnpm prisma migrate reset"],
    allow: ["npx prisma migrate dev --name add_users", "npx prisma migrate deploy"],
  },
  {
    message: "prisma db push with data loss accepted",
    deny: ["npx prisma db push --force-reset --accept-data-loss", "npx prisma db push --accept-data-loss"],
    allow: ["npx prisma db push", "npx prisma db pull"],
  },
  {
    message: "Docker volume delete",
    deny: ["docker volume rm pgdata", "docker volume prune -f", "docker system prune -a --volumes"],
    allow: ["docker volume ls", "docker system prune -f", "docker rm -f web"],
  },
  {
    message: "docker compose down -v (deletes volumes)",
    deny: ["docker compose down -v", "docker-compose down --volumes"],
    allow: ["docker compose down", "docker compose -f docker-compose.dev.yml up -d"],
  },
  {
    message: "Rails database drop/reset",
    deny: ["bin/rails db:drop", "bundle exec rake db:reset", "rails db:purge"],
    allow: ["bin/rails db:migrate", "rails db:seed"],
  },
  {
    message: "Laravel database wipe",
    deny: ["php artisan migrate:fresh --seed", "php artisan db:wipe"],
    allow: ["php artisan migrate", "php artisan tinker"],
  },
  {
    message: "Django database flush",
    deny: ["python manage.py flush --noinput", "django-admin flush"],
    allow: ["python manage.py migrate", "python manage.py test"],
  },
];

describe("incident pack: built-in rules (every preset)", () => {
  for (const { message, deny, allow } of DEFAULT_RULES) {
    describe(message, () => {
      it.each(deny)("denies %s", (cmd) => {
        for (const policy of [def, strict]) {
          const v = blockedCommandsGuard(bash(cmd), policy);
          expect(v.action).toBe("deny");
          expect(v.reason).toBe(`${message} — matched blocked command pattern.`);
        }
      });
      it.each(allow)("allows %s", (cmd) => {
        expect(blockedCommandsGuard(bash(cmd), def).action).toBe("allow");
        expect(blockedCommandsGuard(bash(cmd), strict).action).toBe("allow");
      });
    });
  }
});

describe("strict preset rules", () => {
  for (const { message, deny, allow } of STRICT_RULES) {
    describe(message, () => {
      it.each(deny)("denies %s under strict, allows it under default", (cmd) => {
        const v = blockedCommandsGuard(bash(cmd), strict);
        expect(v.action).toBe("deny");
        expect(v.reason).toBe(`${message} — matched blocked command pattern.`);
        expect(blockedCommandsGuard(bash(cmd), def).action).toBe("allow");
      });
      it.each(allow)("allows %s under both presets", (cmd) => {
        expect(blockedCommandsGuard(bash(cmd), strict).action).toBe("allow");
        expect(blockedCommandsGuard(bash(cmd), def).action).toBe("allow");
      });
    });
  }
});

describe("rule tables cover every shipped rule", () => {
  it("has cases for every incident-pack built-in", () => {
    // The first six built-ins predate the pack and are covered in guards.test.ts.
    const pack = BUILTIN_BLOCKED_COMMANDS.slice(6).map((r) => r.message);
    expect(DEFAULT_RULES.map((r) => r.message)).toEqual(pack);
  });
  it("has cases for every strict rule", () => {
    expect(STRICT_RULES.map((r) => r.message)).toEqual(
      STRICT_PRESET_BLOCKED_COMMANDS.map((r) => r.message),
    );
  });
  it("gives every rule at least one positive and one benign control", () => {
    for (const r of [...DEFAULT_RULES, ...STRICT_RULES]) {
      expect(r.deny.length, r.message).toBeGreaterThan(0);
      expect(r.allow.length, r.message).toBeGreaterThan(0);
    }
  });
});

describe("text that merely mentions a destructive command (issue #2)", () => {
  it.each([
    'grep -rn "terraform destroy" docs/',
    'rg "DELETE FROM users;" src/',
    'grep -i "gh repo delete" README.md',
    'cat runbook.md | grep "kubectl delete namespace"',
    'rg -F "dropDatabase()" src/',
    'grep -rn "git reset --hard" docs/',
    'echo "never run: prisma migrate reset"',
    'echo "do not rmdir /s /q d:\\ on a build box"',
    'git commit -m "docs: warn that Remove-Item -Recurse D:\\ wipes the drive"',
    'git commit -m "fix: delete from cart"',
    'git commit -m "docs: never run terraform destroy against prod"',
    'git commit -am "stop calling FLUSHALL in tests" --no-verify',
    'gh pr create --title "Drop legacy table" --body "Removes the DROP TABLE users; migration"',
    'gh issue comment 12 --body "we should never git reset --hard here"',
  ])("allows the inert, text-only %s under both presets", (cmd) => {
    expect(blockedCommandsGuard(bash(cmd), def).action).toBe("allow");
    expect(blockedCommandsGuard(bash(cmd), strict).action).toBe("allow");
  });

  it.each([
    'echo "DELETE FROM users;" | psql "$DATABASE_URL"',
    'echo "FLUSHALL" | redis-cli',
    'grep -q ok status.txt && terraform destroy -auto-approve',
    'git commit -m "wip" && psql -c "DELETE FROM users;"',
    'git commit -m "$(psql -c \'DELETE FROM users;\')"',
    'gh pr merge 12 && terraform destroy -auto-approve',
    '/tmp/git commit -m "DELETE FROM users;"',
  ])("still denies %s — a non-inert segment disqualifies the skip", (cmd) => {
    expect(blockedCommandsGuard(bash(cmd), def).action).toBe("deny");
  });
});

describe("no shipped rule backtracks catastrophically", () => {
  // Adversarial shapes: long single lines that repeat a rule's keywords.
  // Every rule is linear or at worst line-length quadratic, so these finish
  // in milliseconds; a catastrophic regex would not finish at all.
  const N = 6000;
  const inputs = [
    "a ".repeat(N),
    "-".repeat(N * 2),
    "git ".repeat(N),
    "git " + "reset ".repeat(N),
    "git push " + "origin ".repeat(N),
    "DELETE FROM " + "a.".repeat(N),
    "DELETE FROM " + '"a a".'.repeat(N / 2),
    "curl " + "mutation ".repeat(N / 2),
    "curl " + "mutation delete ".repeat(N / 4) + " https://x",
    "curl https://" + "a-".repeat(N) + " -d mutation{deleteX(",
    "curl mutation deleteX( " + "localhost:1 ".repeat(N / 4),
    "kubectl ".repeat(N / 2),
    "terraform" + " -x".repeat(N) + " plan",
    "aws " + "s3 ".repeat(N),
    "docker compose " + "down ".repeat(N / 2),
    "rails ".repeat(N / 2),
    "redis-cli " + "flush ".repeat(N / 2),
    "rmdir " + "/s ".repeat(N),
    "rd " + "a ".repeat(N) + "/s",
    "rmdir /s " + "a:\\ ".repeat(N / 2),
    "Remove-Item " + "-Recurse ".repeat(N / 2),
    "Remove-Item " + "-r ".repeat(N) + "a:",
  ];

  it("evaluates every rule over adversarial input quickly", () => {
    for (const cmd of inputs) {
      const started = Date.now();
      blockedCommandsGuard(bash(cmd), strict);
      expect(Date.now() - started, cmd.slice(0, 40)).toBeLessThan(1000);
    }
  });
});
