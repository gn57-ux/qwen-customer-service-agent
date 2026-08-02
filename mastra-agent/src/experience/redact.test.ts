import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact } from "./redact.ts";

describe("redact — AC-005 八类脱敏规则", () => {
  it("绝对用户目录被替换，不 blocked", () => {
    const r = redact("配置文件在 /Users/alice/project/config.json 里");
    assert.match(r.text, /\/Users\/<redacted>/);
    assert.equal(r.blocked, false);
    assert.ok(r.redactedCount >= 1);
  });

  it("Token 样式字符串命中 blocked", () => {
    const r = redact("使用 sk-abcdefghijklmnopqrstuvwxyz123456 调用服务");
    assert.equal(r.blocked, true);
  });

  it("AKIA 前缀命中 blocked", () => {
    const r = redact("AWS Key: AKIAABCDEFGHIJKLMNOP");
    assert.equal(r.blocked, true);
  });

  it("Cookie 请求头（低熵短值）命中 blocked", () => {
    const r = redact("请求头 Cookie: session_id=abc123 已附带");
    assert.equal(r.blocked, true);
  });

  it("Set-Cookie 响应头命中 blocked", () => {
    const r = redact("响应里有 Set-Cookie: auth=xyz; Path=/; HttpOnly");
    assert.equal(r.blocked, true);
  });

  it("不带 Cookie: 前缀的已知会话 cookie 名称赋值同样命中 blocked", () => {
    const r = redact("日志片段：PHPSESSID=deadbeef1234 connect.sid=s%3Aabc");
    assert.equal(r.blocked, true);
  });

  it("第十九轮 Codex Review 指出的漏洞：低熵的 API_KEY=... 赋值同样命中 blocked（不依赖值本身熵）", () => {
    const r = redact("配置里写着 API_KEY=abc123，需要改成读环境变量");
    assert.equal(r.blocked, true);
  });

  it("低熵的 client_secret=... 赋值同样命中 blocked", () => {
    const r = redact("OAuth 配置：client_secret=secret 这种默认值必须替换");
    assert.equal(r.blocked, true);
  });

  it("双引号包裹的凭据值同样命中 blocked（JSON/YAML 风格）", () => {
    const r = redact('配置片段：{"api_key": "abc123", "endpoint": "..."}');
    assert.equal(r.blocked, true);
  });

  it("用 : 而不是 = 分隔的凭据赋值同样命中 blocked（YAML 风格）", () => {
    const r = redact("secret_key: mysecretvalue123");
    assert.equal(r.blocked, true);
  });

  it("password/passwd/pwd 赋值同样命中 blocked", () => {
    assert.equal(redact("password=hunter2").blocked, true);
    assert.equal(redact("pwd: qwerty").blocked, true);
  });

  it("access_token/private_key/access_key 赋值同样命中 blocked", () => {
    assert.equal(redact("access_token=abc.def.ghi").blocked, true);
    assert.equal(redact("private_key=-----BEGIN-----").blocked, true);
    assert.equal(redact("access_key=AKIALOWENTROPY").blocked, true);
  });

  it("正常散文里单独出现 password/key/secret 等词（无赋值语法）不应误判 blocked", () => {
    const r = redact("这个字段的 password 校验逻辑有问题，key 的类型定义在 schema.ts 里，属于 secret 管理的一部分");
    assert.equal(r.blocked, false);
  });

  it("邮箱被替换为占位符", () => {
    const r = redact("联系 foo.bar@example.com 处理");
    assert.match(r.text, /<email-redacted>/);
    assert.equal(r.blocked, false);
  });

  it("内网 IP 被替换，127.0.0.1/localhost 不拦截", () => {
    const r = redact("服务地址 192.168.1.10 和 127.0.0.1 与 localhost 都在用");
    assert.match(r.text, /<internal-ip-redacted>/);
    assert.ok(r.text.includes("127.0.0.1"));
    assert.ok(r.text.includes("localhost"));
  });

  it("Git 远程地址的 org/repo 被脱敏，host 保留", () => {
    const r = redact("仓库地址 https://github.com/my-org/my-repo.git 可访问");
    assert.match(r.text, /github\.com\/<org-redacted>\/<repo-redacted>/);
  });

  it("远程主机名被脱敏，常见代码文件名不受影响", () => {
    const r = redact("部署到 api.internal-service.io:8443，代码在 schema.ts 和 package.json 里");
    assert.match(r.text, /<remote-host-redacted>/);
    assert.ok(r.text.includes("schema.ts"), "文件名不应被误判为远程主机");
    assert.ok(r.text.includes("package.json"), "文件名不应被误判为远程主机");
  });

  it("纯数字点分版本号不被误判为远程主机", () => {
    const r = redact("升级到 Node 22.1.0 后问题消失，依赖版本锁定在 4.18.2");
    assert.ok(r.text.includes("22.1.0"), "版本号不应被脱敏");
    assert.ok(r.text.includes("4.18.2"), "版本号不应被脱敏");
    assert.ok(!r.text.includes("<remote-host-redacted>"));
  });

  it("连续 3 行以上对话角色前缀命中 blocked", () => {
    const transcript = ["User: 你好", "Assistant: 你好，有什么可以帮你", "User: 我想查订单"].join("\n");
    const r = redact(transcript);
    assert.equal(r.blocked, true);
  });

  it("少于 3 行对话前缀不触发 blocked", () => {
    const r = redact(["User: 你好", "Assistant: 你好"].join("\n"));
    assert.equal(r.blocked, false);
  });

  it("不含任何敏感信息的正常文本原样通过，不 blocked", () => {
    const text = "先检查订单状态字段是否为 null，再决定是否展示取消按钮";
    const r = redact(text);
    assert.equal(r.blocked, false);
    assert.equal(r.redactedCount, 0);
    assert.equal(r.text, text);
  });
});
