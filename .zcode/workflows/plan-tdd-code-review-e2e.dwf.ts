/* zcode-workflow
description: 开发流水线：给定开发任务 task，先规划并经独立评审，再测试先行（确认变红）、实现转绿，随后代码评审并修复问题，最后生产构建 +
  页面冒烟端到端验收，产出开发报告。
whenToUse: 在本书区监控原型项目上做开发任务（新功能、修 bug、重构）时使用：传入 task
  参数描述要做的事。工作流会按「计划→TDD→代码评审→端到端」推进，遵循 AGENTS.md 与设计文档，以 pnpm verify / pnpm
  build / scripts/e2e-smoke.mjs 作为确定性验收门。
args:
  task:
    type: string
    description: 开发任务描述（要实现的功能或要修复的问题）
    required: true
*/
interface Plan {
  /** 用你自己的话复述这个任务要做成什么，一到两句 */
  understanding: string;
  /** 将新建或修改的文件，工作区相对路径 */
  files: string[];
  /** 有序实施步骤，每步一句话 */
  steps: string[];
  /** 可用 node 原生断言覆盖的纯逻辑测试点；纯 UI 无可测逻辑时给空数组 */
  testPoints: string[];
  /** 风险与必须遵守的约定（引用 AGENTS.md / 设计文档的具体条目） */
  risks: string[];
}

interface PlanReview {
  /** 仅当计划可直接开工时为 true */
  approved: boolean;
  /** 未批准时的具体问题，每条一句话；批准时可为空数组 */
  problems: string[];
}

interface TestOutcome {
  /** 新增或修改的自测文件路径 */
  testFile: string;
  /** 新增的断言点，一句话一个；无可写断言时为空数组 */
  assertions: string[];
  /** 补充说明，例如自测基建是否为本次新建 */
  notes: string;
}

interface Implementation {
  /** 实现摘要：做了什么、关键取舍 */
  summary: string;
  /** 新建或修改的文件 */
  files: string[];
}

interface ReviewFinding {
  /** 工作区相对路径，尽量带行号，如 "src/constants.js:12" */
  where: string;
  /** 一句话说清问题是什么（不是怎么修） */
  what: string;
  /** 证据：读到的代码行，或能证明问题的命令输出 */
  evidence: string;
  /** 严重程度；只有会崩溃、出错结果、丢数据才用 high */
  severity: "low" | "medium" | "high";
}

interface CodeReview {
  findings: ReviewFinding[];
}

interface Resolution {
  /** 对应 findings 数组的下标，从 0 开始 */
  index: number;
  /** fixed=已修复；deferred=不修 */
  action: "fixed" | "deferred";
  /** 修复方式，或不修的理由（误报、超出任务范围等） */
  note: string;
}

interface FixOutcome {
  resolutions: Resolution[];
}

interface ReportedFinding extends ReviewFinding {
  /** 已修复（附方式）或未修复（附理由） */
  status: string;
}

interface WorkflowReport {
  /** 两三句话回答任务做完了没有、质量如何 */
  conclusion: string;
  findings: ReportedFinding[];
  /** 本次实际执行过的验证命令与覆盖范围 */
  verified: string[];
  /** 没有覆盖的检查与原因 */
  notCovered: string[];
}

const DEFAULT_TASK =
  "项目脚手架：按 docs/superpowers/specs/2026-09-22-openlayers-factory-prototype-design.md 与 AGENTS.md 搭建可运行骨架——" +
  "package.json（Vue 3.5.16 / Vite 5 / ol 10.x / sass，scripts 含 dev、build、verify，包管理 pnpm）、.gitignore、" +
  "vite.config.js、index.html、src/main.js、src/App.vue 布局骨架、src/styles/index.scss 与 _variables.scss、" +
  "src/constants.js（报警等级色、区域类型色等枚举常量）、scripts/verify.js（node 原生断言自测入口）。" +
  "本任务不实现具体业务功能，地图/报警/车辆等留给后续任务。";

const DESIGN_DOC = "docs/superpowers/specs/2026-09-22-openlayers-factory-prototype-design.md";
const MAX_PLAN_ROUNDS = 3;
const MAX_RED_ROUNDS = 3;
const MAX_GREEN_ROUNDS = 4;
const MAX_BUILD_ROUNDS = 3;
const MAX_SMOKE_FIX_ROUNDS = 2;
const IGNORED_PATH_PREFIXES = ["node_modules/", "dist/", ".zcode/", ".git/"];

function excerpt(result: { stdout: string; stderr: string }): string {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text.length > 2000 ? text.slice(-2000) : text;
}

function reviewablePaths(paths: string[]): string[] {
  return paths.filter(
    (path) => !IGNORED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) && path !== "pnpm-lock.yaml",
  );
}

function isRealRed(result: { exitCode: number; stdout: string; stderr: string }): { ok: boolean; reason: string } {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === 0) {
    return { ok: false, reason: "自测全部通过（exit 0）——新写的断言必须先失败，先红后绿" };
  }
  if (output.includes("AssertionError")) {
    return { ok: true, reason: "断言失败，测试真实运行过" };
  }
  if (output.includes("Cannot find module") || output.includes("ERR_MODULE_NOT_FOUND")) {
    return { ok: true, reason: "测试引用了尚未实现的模块，符合测试先行" };
  }
  return { ok: false, reason: "verify 失败但既不是断言失败也不是缺模块——先确认测试基建本身能跑" };
}

const task = typeof args.task === "string" && args.task.trim().length > 0 ? args.task.trim() : DEFAULT_TASK;
const shortTask = task.length > 60 ? `${task.slice(0, 60)}…` : task;
log(`开发任务：${task}`);

phase("理解任务并制定实施计划");
const planner = agent("规划师", {
  system:
    "你是资深前端架构师，为 Vue3 + OpenLayers 的厂区监控原型制定实施计划。计划要具体到文件与步骤、可直接开工。" +
    "只能引用仓库里真实存在或计划新建的文件，不要虚构。信息不足时写进 risks，不要编造。",
});
const planReviewer = agent("方案评审员", {
  system:
    "你是严格的技术评审，只找计划的漏洞：遗漏的文件、步骤顺序错误、与项目规范（AGENTS.md）或设计文档冲突、测试点不可断言。" +
    "只有确信照计划开工不会返工才批准。遇到无法核实的缺口，如实说明而不是猜。",
});
let plan: Plan | undefined;
let planApproved = false;
let planProblems: string[] = [];
for (let round = 1; round <= MAX_PLAN_ROUNDS; round += 1) {
  const critique =
    round === 1 || planProblems.length === 0
      ? "这是第一轮，还没有评审意见。"
      : `上一轮评审意见，必须逐条回应：\n${planProblems.map((problem) => `- ${problem}`).join("\n")}`;
  plan = await planner.ask<Plan>(
    `开发任务：${task}\n\n${critique}\n\n动手前先读 AGENTS.md、设计文档 ${DESIGN_DOC} 与仓库现状，再给出计划。`,
  );
  const review = await planReviewer.ask<PlanReview>(
    `评审下面这份实施计划。任务背景：${task}\n\n${JSON.stringify(plan, null, 2)}\n\n` +
      "你要自己读 AGENTS.md、设计文档和计划涉及的文件来核对，不要只看计划文本。批准前先问自己：照这个计划做会不会返工、有没有漏掉的约定。",
  );
  if (review.approved) {
    planApproved = true;
    log("实施计划通过评审");
    break;
  }
  planProblems = review.problems;
  log(`计划第 ${round} 轮未通过评审，${review.problems.length} 条意见`);
}
if (plan === undefined) {
  return {
    conclusion: "规划师没有返回计划，任务未执行。",
    findings: [],
    verified: [],
    notCovered: ["全部——规划阶段即失败"],
  };
}
report({ stage: "实施计划", understanding: plan.understanding, steps: plan.steps, files: plan.files, testPoints: plan.testPoints, approved: planApproved });

const hasTestPoints = plan.testPoints.length > 0;
let redConfirmed = false;
let redReason = "";
let testFile = "";
let assertions: string[] = [];

if (hasTestPoints) {
  phase("测试先行：编写自测并确认变红");
  const tester = agent("测试工程师", {
    system:
      "你为项目写 node 原生断言自测（pnpm verify，无测试框架），坚持测试先行：只写测试与自测基建，绝不实现功能代码。" +
      "任务没有可断言的纯逻辑时如实说明，不硬凑断言。",
  });
  let redFeedback = "";
  for (let round = 1; round <= MAX_RED_ROUNDS; round += 1) {
    const outcome = await tester.ask<TestOutcome>(
      `开发任务：${task}\n\n实施计划：${JSON.stringify(plan)}\n\n` +
        (redFeedback ? `上一轮反馈，先解决它：${redFeedback}\n\n` : "") +
        "把计划里的纯逻辑测试点写成自测断言。项目约定用 pnpm verify 跑 node 原生断言；" +
        "若自测基建还不存在（package.json 的 scripts.verify、scripts/verify.js），先把它搭起来。只写测试，不实现功能。",
    );
    testFile = outcome.testFile;
    assertions = outcome.assertions;
    const red = await world.run("cmd", ["/c", "pnpm", "verify"]);
    const verdict = isRealRed(red);
    if (verdict.ok) {
      redConfirmed = true;
      redReason = verdict.reason;
      log(`自测已变红：${verdict.reason}`);
      report({ stage: "TDD 红", testFile, assertions: assertions.length, reason: redReason });
      break;
    }
    redFeedback = `${verdict.reason}。verify 输出节选：\n${excerpt(red)}`;
  }
}

phase("实现功能直到自测转绿");
const dev = agent("开发工程师", {
  system:
    "你是严格遵循项目规范的前端工程师。代码风格、命名、分层一律按 AGENTS.md 执行。绝不为凑绿删改测试断言；确信测试本身有错，先说明理由再改。" +
    "遇到怎么都过不了的检查或互相矛盾的指令，直接说明并升级，不要绕过或伪造结果。",
});
let impl: Implementation | undefined;
let greenOk = false;
let greenFeedback =
  hasTestPoints && redConfirmed
    ? "自测目前是红的，实现功能让 pnpm verify 转绿。"
    : "按计划实现功能，并保证 pnpm verify 通过（若自测基建尚不存在，先建立最小的）。";
for (let round = 1; round <= MAX_GREEN_ROUNDS; round += 1) {
  impl = await dev.ask<Implementation>(
    `开发任务：${task}\n\n实施计划：${JSON.stringify(plan)}\n\n${greenFeedback}\n需要依赖就用 pnpm 安装；完成后 pnpm verify 必须通过。`,
  );
  const green = await world.run("cmd", ["/c", "pnpm", "verify"]);
  if (green.exitCode === 0) {
    greenOk = true;
    log("自测转绿");
    break;
  }
  greenFeedback = `pnpm verify 仍未通过，输出节选：\n${excerpt(green)}`;
}
if (impl === undefined || !greenOk) {
  const failReport: WorkflowReport = {
    conclusion: `任务未完成：实现阶段多轮修复后自测仍未通过，工作流中止。计划与自测用例已留在工作区，可在此基础上继续。`,
    findings: [],
    verified: redConfirmed ? [`TDD 红阶段确认：新断言先失败（${redReason}）`] : [],
    notCovered: [
      "自测未通过，功能正确性未验证",
      "代码评审、生产构建、页面冒烟均未执行",
      ...(planApproved ? [] : ["实施计划未通过评审即执行"]),
    ],
  };
  await artifact.markdown(
    "report",
    [
      `# 开发报告：${shortTask}`,
      "",
      "## 结论",
      "",
      failReport.conclusion,
      "",
      "## 实施计划（" + (planApproved ? "已通过评审" : "未通过评审") + "）",
      "",
      plan.understanding,
      "",
      ...plan.steps.map((step) => `- ${step}`),
      "",
      "## 已完成",
      "",
      `- 实施计划${planApproved ? "（通过评审）" : "（未通过评审）"}`,
      ...(redConfirmed ? [`- 自测用例（${testFile}，${assertions.length} 个断言点），已确认先红`] : []),
    ].join("\n"),
    { title: "开发报告", primary: true },
  );
  return failReport;
}
report({ stage: "TDD 绿", summary: impl.summary, files: impl.files });

phase("代码评审并修复问题");
let changedPaths: string[];
try {
  changedPaths = await git.changedFiles();
} catch {
  changedPaths = [...(await files.glob("src/**/*")), ...(await files.glob("scripts/*.*"))];
}
const reviewPaths = reviewablePaths(changedPaths);
log(`代码评审覆盖 ${reviewPaths.length} 个改动文件`);
const reviewer = agent("代码评审员", {
  system:
    "你是只读代码评审员，不修改任何文件。对照项目规范找真问题：正确性缺陷、分层违规（如组件直接 import mock、绕过 api 层）、命名与风格偏离。" +
    "每条发现必须自带证据（文件与行，或命令输出）。没有问题就返回空数组，不为了交差硬找。",
});
const review = await reviewer.ask<CodeReview>(
  `开发任务：${task}\n实现摘要：${impl.summary}\n\n改动文件（多为新增文件，直接读文件内容评审）：\n${reviewPaths.join("\n")}\n\n` +
    "对照 AGENTS.md 与设计文档逐文件评审。severity 只在会崩溃、出错结果、丢数据时用 high。",
);
let resolutions: Resolution[] = [];
let reviewFixGreen = true;
const hadFindings = review.findings.length > 0;
if (hadFindings) {
  log(`评审发现 ${review.findings.length} 条问题，交给开发工程师修复`);
  const fix = await dev.ask<FixOutcome>(
    `代码评审发现 ${review.findings.length} 条问题，逐条处理：\n${JSON.stringify(review.findings, null, 2)}\n\n` +
      "能修的修掉（遵循 AGENTS.md）；确属误报或超出本任务范围的可以不修，但必须逐条给出理由。修复不得破坏已有功能。",
  );
  resolutions = fix.resolutions;
  const regreen = await world.run("cmd", ["/c", "pnpm", "verify"]);
  if (regreen.exitCode !== 0) {
    await dev.ask(`修复评审问题后 pnpm verify 失败了，输出节选：\n${excerpt(regreen)}\n修复它，同时保住评审修复。`);
    const regreen2 = await world.run("cmd", ["/c", "pnpm", "verify"]);
    reviewFixGreen = regreen2.exitCode === 0;
  }
} else {
  log("评审未发现问题");
}
const reportedFindings: ReportedFinding[] = review.findings.map((finding, index) => {
  const resolution = resolutions.find((item) => item.index === index);
  const status =
    resolution === undefined
      ? "未回应（修复者未逐条说明）"
      : resolution.action === "fixed"
        ? `已修复：${resolution.note}`
        : `未修复：${resolution.note}`;
  return { ...finding, status };
});
reportedFindings.forEach((finding) => report({ stage: "评审发现", ...finding }));

phase("端到端验收：构建与页面冒烟");
let buildOk = false;
for (let round = 1; round <= MAX_BUILD_ROUNDS; round += 1) {
  const build = await world.run("cmd", ["/c", "pnpm", "build"], { timeoutMs: 600000 });
  if (build.exitCode === 0) {
    buildOk = true;
    log("生产构建通过");
    break;
  }
  log(`构建第 ${round} 轮失败，交给开发工程师修复`);
  await dev.ask(`pnpm build 失败，输出节选：\n${excerpt(build)}\n修复构建错误，不改变功能语义。`);
}
let smokeOk: boolean | null = null;
if (buildOk) {
  const existingSmoke = await files.glob("scripts/e2e-smoke.mjs");
  if (existingSmoke.length === 0) {
    await dev.ask(
      "编写 scripts/e2e-smoke.mjs 页面冒烟脚本：优先用 vite 的编程 API（如 import { preview } from 'vite'）基于 dist 启动预览服务器，" +
        "用 fetch 请求首页，断言 HTTP 200、HTML 包含应用挂载根节点、HTML 引用的 JS 入口也能请求成功（非 404）；" +
        "任何断言失败用 console.error 打印原因并 process.exit(1)；结束前关闭服务器。要求跨平台、不依赖 shell 命令拼接（Node 18+ 有全局 fetch）。",
    );
  }
  for (let round = 1; round <= MAX_SMOKE_FIX_ROUNDS + 1; round += 1) {
    const smoke = await world.run("node", ["scripts/e2e-smoke.mjs"], { timeoutMs: 180000 });
    if (smoke.exitCode === 0) {
      smokeOk = true;
      log("页面冒烟通过");
      break;
    }
    if (round <= MAX_SMOKE_FIX_ROUNDS) {
      await dev.ask(
        `页面冒烟失败，输出节选：\n${excerpt(smoke)}\n判断是脚本问题还是页面问题并修复：脚本问题改脚本，页面问题改代码。`,
      );
    }
  }
}

const verified: string[] = [];
if (planApproved) verified.push("实施计划经独立评审通过");
if (hasTestPoints) {
  if (redConfirmed) verified.push(`TDD 红：新断言先失败（${redReason}）`);
  if (greenOk) verified.push(`TDD 绿：pnpm verify 通过（自测文件 ${testFile}，${assertions.length} 个断言点）`);
} else if (greenOk) {
  verified.push("pnpm verify 通过（任务无可断言纯逻辑，未新增断言）");
}
if (reviewPaths.length > 0) verified.push(`代码评审覆盖 ${reviewPaths.length} 个改动文件`);
if (hadFindings && reviewFixGreen) verified.push("评审修复后 pnpm verify 复跑通过");

const fixedCount = reportedFindings.filter((finding) => finding.status.startsWith("已修复")).length;
const notCovered: string[] = [];
if (!planApproved) notCovered.push("实施计划多轮评审仍未获批准，按最后一版执行");
if (hasTestPoints && !redConfirmed) notCovered.push("TDD 红未确认：限定轮数内新断言没有以失败告终");
if (!hasTestPoints) notCovered.push("任务无可断言的纯逻辑测试点，红绿循环未执行（依计划判定）");
if (hadFindings && !reviewFixGreen) notCovered.push("评审修复后自测未复绿——工作区可能处于破损状态，需人工检查");
if (!buildOk) notCovered.push("生产构建未通过——页面冒烟随之未执行");
else if (smokeOk !== true) notCovered.push("页面冒烟未通过");
notCovered.push("设计文档第 6 节的浏览器手动验收清单（交互与渲染效果）需人工逐项确认，工作流子代理没有浏览器");
notCovered.push("真实后端替换 api/ 层后的联调验证（超出本任务范围）");

const allGatesOk = greenOk && buildOk && smokeOk === true;
const conclusion = allGatesOk
  ? `任务完成：TDD 红→绿（${assertions.length} 个断言点），生产构建与页面冒烟通过；代码评审 ${review.findings.length} 条发现，修复 ${fixedCount} 条` +
    (fixedCount < review.findings.length ? "，其余附不修理由见报告" : "") +
    "。"
  : `任务部分完成：自测${greenOk ? "通过" : "未通过"}、构建${buildOk ? "通过" : "未通过"}、页面冒烟${smokeOk === true ? "通过" : "未通过"}；评审 ${review.findings.length} 条发现，修复 ${fixedCount} 条。未过项与原因见「未覆盖」。`;

const markdown = [
  `# 开发报告：${shortTask}`,
  "",
  "## 结论",
  "",
  conclusion,
  "",
  `## 实施计划（${planApproved ? "已通过评审" : "未通过评审"}）`,
  "",
  plan.understanding,
  "",
  ...plan.steps.map((step) => `- ${step}`),
  "",
  "## TDD 过程",
  "",
  hasTestPoints && redConfirmed
    ? `- 红：${redReason}`
    : hasTestPoints
      ? "- 红：未确认（见未覆盖）"
      : "- 本任务无纯逻辑测试点，跳过红绿循环",
  `- 绿：pnpm verify ${greenOk ? "通过" : "未通过"}`,
  ...(testFile ? [`- 自测文件：${testFile}（${assertions.length} 个断言点）`] : []),
  "",
  "## 代码评审",
  "",
  ...(review.findings.length === 0
    ? ["评审未发现问题。"]
    : reportedFindings.map(
        (finding) =>
          `- **${finding.where}**（${finding.severity}，${finding.status}）：${finding.what}\n  - 证据：${finding.evidence}`,
      )),
  "",
  "## 已验证",
  "",
  ...verified.map((item) => `- ${item}`),
  "",
  "## 未覆盖",
  "",
  ...notCovered.map((item) => `- ${item}`),
].join("\n");

await artifact.markdown("report", markdown, {
  title: "开发报告",
  description: `计划 → TDD → 评审 → 端到端的全过程记录：${shortTask}`,
  primary: true,
});

const finalReport: WorkflowReport = { conclusion, findings: reportedFindings, verified, notCovered };
return finalReport;