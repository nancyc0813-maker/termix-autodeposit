# TermiX AutoDeposit 使用教程

**English guide: [scroll down ↓](#english-guide)**

> 用币安 AI 钱包自动存入 TermiX 策略赚积分，6 小时或 1 天一单，到期本金自动回到你自己的钱包。
> 工具免费、开源、在你自己的电脑上运行。用不用都由你决定，它只是帮你省时间的小工具。

---

## 一、先搞懂：为什么要做 TermiX 策略存款？

- TermiX 官方积分规则里，**真正结算完成的 Agent 任务是积分的核心权重**。社交任务（关注、转发）只能拿一次性的分数。
- 策略存款活动规则：**每 1U 跑满一单（6 小时）= 100 TP**。存 100U 跑一单就是 10,000 TP。
- 损耗很低：每单固定成本约 0.002 BNB 的 gas，加上很少的策略手续费（例如年化 2% 的策略，1000U 跑 6 小时约 0.014 USDC）。本金跑完自动收回。
- 手动做的话，每 6 小时都要自己下单、授权、到期收回，非常麻烦。这个工具帮你全自动完成。

---

## 二、准备

1. **一台 Windows 10/11 电脑**（不用另外安装任何软件，运行环境已经内附在工具包里）。
2. **币安 App 里的 AI 钱包（Agentic Wallet）**，并开启「开发者模式」：
   币安 App → 钱包 → Agentic Wallet → 设置 → 开发者模式。
3. AI 钱包里放：
   - 要存的 **USDC（BSC 链）**，每单最少 10U；
   - 至少 **0.008 BNB** 当 gas（每单实际约用 0.002 BNB：开单时先转 0.004 到任务钱包当 gas，用剩到期退回；另 0.004 留在钱包）。
   - 工具会在钱包留 0.2 USDC 付手续费，所以钱包有 20U 时，一单实际存 19U。

> 建议 AI 钱包只放用来撸分的钱。

---

## 三、下载与安装（只要做一次）

1. 到 GitHub 下载工具：**只从 Nancy（@nancy_c813）的官方 GitHub 下载**
   直接下载最新版：https://github.com/nancyc0813-maker/termix-autodeposit/archive/refs/heads/main.zip
   （或打开 https://github.com/nancyc0813-maker/termix-autodeposit ，点绿色的「Code」→「Download ZIP」）
2. **先解压，再打开。** 在下载的 ZIP 上按右键 →「全部解压缩」（或 WinRAR「解压到…」），解压到 **C:\TermiX** 这类固定位置。
   ⚠️ **不要在 WinRAR／压缩包里直接双击里面的文件**，那样只会解出一个文件到暂存文件夹，工具打不开，密钥也可能存到会被删除的地方（新版工具会跳提示拦下来）。
   ⚠️ 不要放在会自动同步到云盘的文件夹（OneDrive、Google Drive；很多电脑的「桌面」「文件」会被同步），否则任务钱包的密钥可能被上传。
3. 打开解压好的文件夹，双击 **Start-TermiX.vbs**。
   - Windows 可能跳出「安全警告／未知的发行者（Unknown Publisher）」：这是 Windows 对所有网络下载的脚本都会显示的提示，按「**打开**」即可。
   - 第一次会自动安装需要的组件（约 100MB，2～5 分钟），装好会自动打开控制窗口，桌面也会出现「TermiX AutoDeposit」图标。安装期间请不要重复点。
4. 之后电脑重开机，工具会自己在背景启动；想看控制窗口，点桌面图标即可。

---

## 四、首次设置（控制窗口会一步步带你做，约 3 分钟）

1. **连接钱包**：按「连接钱包」，用币安 App 扫电脑上的 QR 码，核对配对码一致后按确认。
2. **开发者模式**：在 App 开好后，按「重新检查」。
3. **登录 TermiX**：自动完成。
4. **同意 TermiX 使用条款**：必须你本人阅读并勾选同意（工具和 AI 都不会替你同意）。
5. **启用代理身份**：已经有币安 Agent ID 的会自动启用（不收费）；没有的按「新建代理身份」（约 0.0002 BNB）。也可以先在币安 App → 钱包 → Agent ID 卡片免费领一个，再回来按「重新检查」。
6. **邀请人**（一次性，绑了不能改）：栏位默认填了作者的邀请码 **X8UTKPUM**，也可以改成别的或不绑。

---

## 五、开始自动存款

先选「怎么选策略」：

**自动挑选（推荐，最省事）**
1. 设置「每单存入金额」（10～1000U）和「跑几单后停止」（0 = 一直跑；1 = 只存一次）。
2. 按 **「开始自动存款」**。
3. 工具会自动挑 Nancy 上架、并通过 TermiX 官方审核、还有空位的策略（Venus USDC 收息类或 USDC 原封持有类），一次跑一笔，每单 6 小时。

**自己选策略、期限、金额（想一次存多个策略）**
1. 按「＋ 添加策略」，每一列选：策略、期限（6 小时或 1 天；币安开发者模式一次最长约 7 天，所以不开放更长的期限）、金额（10～1000U，不超过这个策略剩下的空位）。最多 12 个。
2. 画面会算出每单积分、每天大约积分，以及钱包需要准备多少 USDC 和 BNB（每个策略约 0.004 BNB）。
3. 按「保存设置」→「开始自动存款」。选的每个策略会同时各跑各的；要在币安 App 确认的交易会排队，一次只跳一笔。

> ⚠️ 期限越长积分越少：官方规则是每 1U 跑完「一单」= 100 TP，不论这单是 6 小时还是 1 天。想要积分最多，就选 6 小时。

画面上的「进行中」会显示每一单的进度：存入 → 策略方接单 → 运行 6 小时 → 收回本金 → 结算积分。
「我的积分」显示的是 TermiX 官方积分，每 5 分钟更新。

---

## 六、币安 App 会跳出的确认（重要，请看完）

工具在下面这些时候，会请你在币安 App 按确认。工具画面上方也会出现黄色提示，告诉你要确认什么。

**1. 第一单：授权手续费额度（额度用完才会再请你确认，约 70 单一次）**
授权 1 USDC 给 TermiX 官方托管合约 **0x6A52…913C**，只能用来付 TermiX 的手续费。
App 会标示「高风险交易」，这是因为它是你第一次授权的新合约。核对地址后按确认即可。

**2. 「异常收款地址：7702 账户使用了一个不常见的委托合约」**
转入本金（或补 gas）到任务钱包时可能跳出。原因是：
- 收款地址是工具为你产生的**任务钱包**，不是陌生人的地址；
- 为了把策略方的权限锁死在「只能存入／赎回 Venus」，任务钱包用 **EIP-7702** 升级成了智能账户；
- 币安对这类较新的委托合约一律会提醒，这不代表被盗。

核对收款地址就是工具「进行中」那一笔显示的任务钱包，对得上就按「继续交易」；对不上就按「取消交易」。

**3. 用 OKX 钱包查托管合约 0x6A52…913C 显示「异常钱包」**
同样是对新合约的风控提醒，核对地址正确即可。

**4. 之后几种少见的确认（工具画面上方会显示黄色提示）**
- 确认放款：单子结束后把手续费放给策略方，积分才会入账（没确认的话，平台到期也会自动放款）。
- 确认取消订单／逾期退费：策略方没接单或逾期时，确认后手续费退回你的钱包。

**找不到要确认的交易？**
到 App → 钱包 → Agentic Wallet 管理页的「待确认」或通知列表找。若你把 App 设成「高风险交易自动拒绝」，请到管理页右上角设置改成「需要确认」，工具会自动重送。
同一笔交易工具最多提醒 3 次；3 次都没确认，这一单会自动取消、收回本金。

---

## 七、交给你的 AI 操作（最省事，任何语言都行）

把工具文件夹里的 **「给AI的使用说明.md」** 丢给你的 AI（Claude、Grok 等）。
AI 会用 `runtime\node\node.exe app/cli.mjs status`（或电脑已装的 node） 查状态、帮你开始／停止，并用你的语言告诉你哪一步要你本人做（扫码、开开发者模式、在 App 按确认、同意条款）。

---

## 八、常用按钮

| 按钮 | 作用 |
|---|---|
| 开始自动存款 | 一单接一单自动跑 |
| 停止开新单 | 不再开新单；进行中的会跑完、自动收回 |
| 全部收回 | 马上中止所有单、把本金转回你的钱包（还没跑满期限的单拿不到积分） |
| 右上角语言 | 简体中文、English、한국어、Tiếng Việt、日本語 |
| 「⋯」→ 反馈问题 | 先让你看要发送的内容（不含密钥、私人信息），按「发送反馈」作者就会收到 |

---

## 九、工具怎么保护你的钱

- 本金只在「你的币安 AI 钱包 ⇄ 工具产生的任务钱包」之间移动，收回目的地固定是你自己的钱包，工具里没有任何可以改转出地址的地方。
- 给策略方的权限只到「函数」层级：Venus 类只能存入／赎回 Venus；持有类没有任何操作权限；都不能转账、借款或换币。
- 每单结束先在链上撤销策略方授权，再收回本金；收回时核对金额，短少就停止并通知你。
- 钱包断线、电脑重开时，到期的单照样自动收回。
- 任务钱包的密钥只存在你的电脑：`工具文件夹\data\seed\` 和 `你的用户文件夹\TermiX-AutoDeposit-Backup (DO NOT DELETE)\`（旧版为 `TermiX-自动存款-备份（不要删除）`）。只要任务钱包还有钱，这两个地方都不要删、不要给任何人看。

---

## 十、费用与在线更新

- 每单 gas 约 0.002 BNB（开单时先转 0.004，用剩退回）；策略手续费依各策略费率（年化最高 3%），按存款期限计算。
- 即使某一单没拿到积分（例如中途被取消），gas 也已经花掉。积分规则以 TermiX 官方为准。
- 工具每 5 分钟检查一次 GitHub 上的新版本并自动更新（只换程序文件，不动 `data\` 里的钱包密钥、设置和进行中的单）。每个更新都有作者签名，验证通过才会安装；更新后打不开会自动退回上一版。
- 不想自动更新：右上角「⋯」→ 关掉「自动更新」，之后自己按「检查更新」。

---

还没注册 TermiX？用我的邀请链接：**https://www.agent.family/r/X8UTKPUM**
有问题欢迎在控制窗口「⋯」→「反馈问题」，或到我的 TG 群：t.me/nancy_c0813

---

<a id="english-guide"></a>
# English guide

> Auto-deposit into TermiX strategies with your Binance AI wallet to earn points. Each round runs 6 hours (or 1 day); when it ends, your funds return to your own wallet automatically.
> Free, open source, runs on your own computer.

## 1. Before you start
1. **A Windows 10/11 PC.** Nothing else to install — the runtime (Node.js) is bundled in the package.
2. **Binance App → Wallet → Agentic Wallet**, with **Developer Mode** turned on (Agentic Wallet → Settings → Developer Mode).
3. In the AI wallet: the **USDC (BSC)** you want to deposit (at least 10U per round) plus **at least 0.008 BNB** for gas: each round sends 0.004 BNB to the task wallet, actually uses about 0.002, and returns the rest; 0.004 stays in your wallet. The tool also keeps about 0.2U USDC for fees (20U in the wallet → 19U deposited).

> Tip: only keep the funds you use for farming in the AI wallet.

## 2. Download & install (once)
1. Download only from the official repo:
   https://github.com/nancyc0813-maker/termix-autodeposit/archive/refs/heads/main.zip
2. **Extract first, then open.** Right-click the ZIP → **Extract All** (or WinRAR "Extract to…") into a fixed folder such as **C:\TermiX**.
   - ⚠️ **Do not double-click files inside WinRAR / the zip.** That only unpacks one file into a temporary folder: the tool cannot start, and keys could end up in a folder that gets deleted. (The tool now shows a warning and stops.)
   - ⚠️ Do not use a cloud-synced folder (OneDrive / Google Drive; Desktop and Documents are often synced).
3. Open the extracted folder and double-click **Start-TermiX.vbs**.
   - If Windows shows a **Security Warning / Unknown Publisher**, click **Open**. Windows shows this for every script downloaded from the internet.
   - The first run installs components (~100 MB, 2–5 min), then the control window opens and a **TermiX AutoDeposit** desktop icon appears. Don't click again while it installs.
4. After a reboot the tool starts by itself in the background; click the desktop icon to open the window.

## 3. First-time setup (about 3 minutes, the window guides you)
1. **Connect wallet** — scan the QR code with the Binance App, check the pairing code matches, confirm.
2. **Developer Mode** — turn it on in the App, then click **Re-check**.
3. **Sign in to TermiX** — automatic.
4. **Agree to the TermiX Terms** — you must read and tick this yourself.
5. **Activate agent** — a Binance Agent ID you already hold is activated for free; without one, click **Create agent** (about 0.0002 BNB). Tip: you can claim a free Agent ID in Binance App → Wallet → Agent ID card.
6. **Inviter** (one-time, can't be changed) — pre-filled with the author's code **X8UTKPUM**; you can change it or leave it empty.

Use the language menu at the top right: 简体中文 / English / 한국어 / Tiếng Việt / 日本語.

## 4. Start
- **Auto pick (recommended):** set the amount per round (10–1000U) and how many rounds (0 = run forever), then click **Start auto-deposit**.
- **Pick yourself:** **+ Add strategy**, choose strategy, term (6h or 1 day) and amount for each row, **Save settings**, then **Start**.
- Points rule: every 1U that completes one round = 100 TP, no matter whether the round is 6h or 1 day — so 6h earns the most.

## 5. Confirmations in the Binance App
- **First round:** approve 1 USDC fee allowance to the official TermiX escrow **0x6A52…913C** (asked again only when the allowance runs out, about every 70 rounds). The App may label it high-risk because it's a new contract — check the address and confirm.
- **"Unusual recipient / 7702 delegate" warning** when funding the task wallet: the recipient is the task wallet the tool created for you (locked so the strategy can only supply/redeem on Venus). If the address matches the one shown under *In progress*, continue.
- **Later, less common confirmations** (a yellow banner appears in the tool): *confirm payout* (releases the fee so your points are credited; the platform also releases it automatically later), *confirm cancel / overdue refund* (refunds the fee to your wallet).
- Can't find the request? Look under *Pending* / notifications on the Agentic Wallet page. Each request is re-sent up to 3 times; if never confirmed, the round is cancelled and funds return.

## 6. Let your AI run it
Give **给AI的使用说明.md** (AI instructions) in the tool folder to your AI (Claude, Grok, …). It uses `runtime\node\node.exe app/cli.mjs status|start|stop` (or an installed node) and tells you, in your language, which steps you must do yourself.

## 7. Safety
- Funds only move between your Binance AI wallet and the task wallet the tool creates; the return address is always your own wallet.
- The strategy can only call allowed functions (supply/redeem on Venus, or nothing for hold strategies) — no transfers, borrowing or swaps.
- Task-wallet keys stay on your PC: `tool folder\data\seed\` and `your user folder\TermiX-AutoDeposit-Backup (DO NOT DELETE)\`. Don't delete or share them while a task wallet holds funds.

## 8. Fees & updates
- Gas about 0.002 BNB per round (0.004 is sent first, the rest comes back); strategy fees per each strategy's rate (max 3%/year), pro-rated by term.
- The tool checks GitHub for signed updates **every 5 minutes** and installs them automatically (your keys, settings and active rounds are never touched).

Not on TermiX yet? Invite link: **https://www.agent.family/r/X8UTKPUM**
Questions: control window **⋯ → Report a problem**, or TG: t.me/nancy_c0813
