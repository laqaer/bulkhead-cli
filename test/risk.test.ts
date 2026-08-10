import { describe, it, expect } from "vitest";
import { assessRisk } from "../src/risk.js";
import type { ToolCall } from "../src/types.js";

const bash = (command: string): ToolCall => ({ toolName: "Bash", toolInput: { command } });
const write = (file_path: string): ToolCall => ({ toolName: "Write", toolInput: { file_path } });

describe("assessRisk — egress / side effects (high)", () => {
  const highCases: Array<[string, string]> = [
    ["git push origin feature", "git-push"],
    ["gh pr create --fill", "gh-mutate"],
    ["gh release create v1.0", "gh-mutate"],
    ["npm publish", "publish"],
    ["docker push myimage:latest", "docker-push"],
    ["aws s3 rm s3://bucket/key", "cloud-mutate"],
    ["kubectl apply -f deploy.yaml", "cloud-mutate"],
    ["terraform apply -auto-approve", "cloud-mutate"],
    ["ssh prod-box 'systemctl restart api'", "remote-transfer"],
    ["curl -X POST https://api.example.com/deploy", "http-mutate"],
    ["curl -d @payload.json https://hook.example.com", "http-mutate"],
    ["sudo rm /var/log/old.log", "privilege"],
    ["git filter-repo --path secrets --invert-paths", "git-history-rewrite"],
  ];
  for (const [command, id] of highCases) {
    it(`high: ${command}`, () => {
      const r = assessRisk(bash(command));
      expect(r.level).toBe("high");
      expect(r.signals.map((s) => s.id)).toContain(id);
    });
  }
});

describe("assessRisk — dependency / history (medium)", () => {
  const medCases: string[] = [
    "npm install left-pad",
    "pnpm add zod",
    "pip install requests",
    "cargo add serde",
    "go get github.com/foo/bar",
    "brew install jq",
    "git reset --hard HEAD~1",
    "git clean -fd",
  ];
  for (const command of medCases) {
    it(`medium: ${command}`, () => {
      expect(assessRisk(bash(command)).level).toBe("medium");
    });
  }
  it("sensitive-path write is medium", () => {
    expect(assessRisk(write("/repo/.github/workflows/deploy.yml")).level).toBe("medium");
    expect(assessRisk(write("/repo/Dockerfile")).level).toBe("medium");
    expect(assessRisk(write("/repo/pnpm-lock.yaml")).level).toBe("medium");
  });
});

describe("assessRisk — NOT risky (no false positives)", () => {
  const safe: string[] = [
    "npm test",
    "npm install", // bare restore, no package
    "pnpm i", // bare
    "ls -la",
    "git status",
    "git commit -m 'wip'",
    "git log --oneline",
    "cat README.md",
    "grep -rn 'aws deploy' notes.txt", // command names inside args/quotes
    "echo 'git push origin main'",
    "curl https://example.com", // GET, no data
    "python script.py",
    "git pull",
    "git diff",
  ];
  for (const command of safe) {
    it(`not risky: ${command}`, () => {
      expect(assessRisk(bash(command)).level).toBeUndefined();
    });
  }
  it("ordinary source write is not risky", () => {
    expect(assessRisk(write("/repo/src/index.ts")).level).toBeUndefined();
  });
  it("read-only cloud command is not risky", () => {
    expect(assessRisk(bash("aws s3 ls s3://bucket")).level).toBeUndefined();
    expect(assessRisk(bash("kubectl get pods")).level).toBeUndefined();
  });
});

describe("assessRisk — cloud CLI verb position (review regressions)", () => {
  it("kubectl READ of a 'deploy' resource is NOT flagged", () => {
    expect(assessRisk(bash("kubectl get deploy")).level).toBeUndefined();
    expect(assessRisk(bash("kubectl get deploy -n prod")).level).toBeUndefined();
    expect(assessRisk(bash("kubectl describe deploy web")).level).toBeUndefined();
    expect(assessRisk(bash("kubectl rollout status deployment/web")).level).toBeUndefined();
    expect(assessRisk(bash("kubectl rollout history deploy/api")).level).toBeUndefined();
  });
  it("kubectl mutations still flagged", () => {
    expect(assessRisk(bash("kubectl apply -f x.yaml")).level).toBe("high");
    expect(assessRisk(bash("kubectl delete pod web")).level).toBe("high");
    expect(assessRisk(bash("kubectl rollout restart deploy/web")).level).toBe("high");
  });
  it("aws READ operations (get-/list-/describe-) are NOT flagged", () => {
    expect(assessRisk(bash("aws deploy list-applications")).level).toBeUndefined();
    expect(assessRisk(bash("aws deploy get-deployment --deployment-id d-1")).level).toBeUndefined();
    expect(assessRisk(bash("aws ec2 describe-instances")).level).toBeUndefined();
    expect(assessRisk(bash("aws s3 ls s3://bucket")).level).toBeUndefined();
  });
  it("aws hyphenated MUTATING verbs ARE flagged", () => {
    expect(assessRisk(bash("aws ec2 terminate-instances --instance-ids i-0abc")).level).toBe("high");
    expect(assessRisk(bash("aws cloudformation delete-stack --stack-name prod")).level).toBe("high");
    expect(assessRisk(bash("aws rds delete-db-instance --db-instance-identifier db1")).level).toBe("high");
    expect(assessRisk(bash("aws lambda delete-function --function-name f")).level).toBe("high");
    expect(assessRisk(bash("aws s3 rm s3://bucket/key")).level).toBe("high");
  });
  it("gcloud verb-in-the-middle is classified correctly", () => {
    expect(assessRisk(bash("gcloud compute instances create web-1")).level).toBe("high");
    expect(assessRisk(bash("gcloud compute instances delete web-1")).level).toBe("high");
    expect(assessRisk(bash("gcloud compute instances list")).level).toBeUndefined();
    expect(assessRisk(bash("gcloud app deploy")).level).toBe("high");
  });
  it("terraform plan is read (not flagged); apply/destroy are", () => {
    expect(assessRisk(bash("terraform plan")).level).toBeUndefined();
    expect(assessRisk(bash("terraform destroy -auto-approve")).level).toBe("high");
  });
});

describe("assessRisk — gh read vs write (review regression)", () => {
  const reads = ["gh pr list", "gh pr view 12", "gh pr diff", "gh pr checkout 3", "gh repo view", "gh workflow list", "gh secret list", "gh release view v1"];
  for (const c of reads) {
    it(`read not flagged: ${c}`, () => expect(assessRisk(bash(c)).level).toBeUndefined());
  }
  const writes = ["gh pr create --fill", "gh pr merge 12", "gh release create v1", "gh repo delete owner/x", "gh secret set TOKEN", "gh workflow run deploy"];
  for (const c of writes) {
    it(`write flagged: ${c}`, () => expect(assessRisk(bash(c)).level).toBe("high"));
  }
});

describe("assessRisk — multi-line commands (review regression)", () => {
  it("a risky action on a later line is still caught", () => {
    expect(assessRisk(bash("git add -A\ngit commit -m x\ngit push origin main")).level).toBe("high");
    expect(assessRisk(bash("cd /tmp\nsudo rm -rf junk")).level).toBe("high");
    expect(assessRisk(bash("npm run build\nnpm publish")).level).toBe("high");
  });
  it("a multi-line commit message is not split (quotes protect it)", () => {
    expect(assessRisk(bash('git commit -m "line1\nline2 mentions git push"')).level).toBeUndefined();
  });
});

describe("assessRisk — long-form flags (review regression)", () => {
  it("git clean --force is detected", () => {
    expect(assessRisk(bash("git clean --force -d")).level).toBe("medium");
  });
  it("composer install (restore) is NOT flagged; require is", () => {
    expect(assessRisk(bash("composer install")).level).toBeUndefined();
    expect(assessRisk(bash("composer require monolog/monolog")).level).toBe("medium");
  });
});

describe("assessRisk — scoring and levels", () => {
  it("level is the max signal; score accumulates", () => {
    const r = assessRisk(bash("sudo npm install foo")); // privilege(high) + dependency(medium)
    expect(r.level).toBe("high");
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.signals.length).toBeGreaterThanOrEqual(2);
  });
  it("compound command scores each segment", () => {
    const r = assessRisk(bash("npm run build && git push origin main"));
    expect(r.signals.map((s) => s.id)).toContain("git-push");
  });
  it("WebFetch tool is medium", () => {
    expect(assessRisk({ toolName: "WebFetch", toolInput: { url: "https://x" } }).level).toBe("medium");
  });
});
