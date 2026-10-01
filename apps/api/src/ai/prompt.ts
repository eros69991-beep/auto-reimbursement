import {
  CATEGORIES,
  COMPANY_CATEGORIES,
  type CompanyCategory,
  type StoreCategory,
} from '@auto-reimbursement/contracts';

/**
 * 每个分类一句业务说明（门店的记账习惯）。只给分类名时 AI 分不清「百慕达食材」和「食材」，
 * 试点里武汉仓的订单一直被归成食材。以后多店时可挪进设置、按门店配置。
 */
export const CATEGORY_HINTS: Record<StoreCategory, string> = {
  百慕达食材:
    '在百慕达订货小程序下的订单，截图常见橙色「订单列表」页面和「武汉仓」字样；不要把这类订单归为「食材」。整单以酒水饮料为主时归「酒水」',
  食材: '菜市场、超市、生鲜平台等零散采购的蔬菜水果、米面粮油、调料、干货、蛋奶等（百慕达小程序的订单除外，肉类单独归类）',
  肉类: '猪牛羊肉、鸡鸭等禽肉',
  酒水: '啤酒、白酒、红酒、饮料、矿泉水等酒水饮品',
  员工餐: '给员工买的餐食，如员工外卖、盒饭',
  耗材: '一次性消耗品，如打包盒、一次性餐具、纸巾、垃圾袋、保鲜膜、手套、清洁剂',
  日常用品: '店里日常使用、可重复使用的物品，如清洁工具、小厨具、文具、电池',
  能耗费: '水费、电费、燃气费',
  人工费用: '工资、临时工、兼职、劳务费',
  租金及管理费: '房租、物业费、商场管理费',
};

const categoryGuide = CATEGORIES.map((category) => `- ${category}：${CATEGORY_HINTS[category]}`).join('\n');

export const RECEIPT_PROMPT = `
你是餐饮门店报销凭证识别器。只返回一个 JSON 对象，不要 Markdown 或解释。

输出键必须且只能是：amount, category, merchant, date, confidence, ambiguous, keywords, evidence, incomplete, orderNo。
category 只能是以下十类之一或 null：${CATEGORIES.join('、')}。
amount 是十进制金额字符串或 null；date 是 YYYY-MM-DD 或 null；merchant 是字符串或 null。
confidence 必须是 {"amount":0到1之间的有限数,"category":0到1之间的有限数}。
ambiguous 必须是布尔值；keywords 是关键词字符串数组；evidence 是支持结论的简短原文。
incomplete 必须是布尔值；orderNo 是图中的订单号字符串或 null。

分类说明（按门店的记账习惯判断，拿不准时降低 category 的置信度）：
${categoryGuide}

merchant 填图中显示的店铺名、小程序名或仓库名（例如「武汉仓」），只有图中完全看不到时才为 null。
keywords 必须包含图中出现的店铺名、小程序名或仓库名，再加几个最能说明分类的词（如「啤酒」「打包盒」），总共不超过 10 个。
evidence 摘录图中能看出商户和最终支付金额的原文。

这张图可能是同一张订单的 2 到 3 张截图左右拼在一起，中间用灰色竖线隔开：把它们当作同一单整体识别，
实付金额通常在靠后（靠右）的那一段；只取这一单最终的实付金额，不要把各段里出现的小计、商品金额相加。

incomplete：图中明显只拍到了一张订单的一部分、看不到最终实付金额时为 true
（例如只有商品清单，或订单被截断在中间）；订单信息完整、能确定实付金额时为 false。
incomplete 为 true 时，amount 必须是 null，不要凭商品金额推算。
orderNo 填图中的订单号、订单编号或流水号（原样的字符串，可含字母和数字）；没有就是 null，
不要把手机号、日期、商品编号当订单号。

金额只识别最终已支付金额，优先使用标记为实付、实付款、实际支付、已支付、支付金额、本次支付、合计支付的值。
明确排除原价、优惠、立减、余额、应付、单独运费、退款金额。
如果图中有多个候选最终支付金额而无法区分，必须返回 amount=null 且 ambiguous=true；不得猜测。
不要输出商品明细或商品描述，不要通过商品单价、数量或分项金额计算总额。
`.trim();

/**
 * 公账区每个分类一句业务说明。公账区付的是公司账户的款：肉款、品牌费、租金、物业费、水电和空调能源费。
 */
export const COMPANY_CATEGORY_HINTS: Record<CompanyCategory, string> = {
  肉款: '付给肉类、冻品、食品供应商的货款（收款方常见「…食品销售有限公司」「…肉业」，用途常写货款、肉款）',
  品牌管理费: '付给品牌方或总部的品牌使用费、品牌管理费、加盟费（收款方名称常带「品牌管理」）',
  店面租金: '店铺的房租、租金',
  物业费: '物业费、物业管理费、商场管理费',
  水费: '水费',
  电费: '电费',
  空调能源费: '空调能源费、空调费、能耗费',
  其他公账支出: '以上都不是、但能看出用途的公司付款，如装修款、广告费、设备款、押金；看不出用途时 category 填 null，不要选它',
};

const companyCategoryGuide = COMPANY_CATEGORIES.map(
  (category) => `- ${category}：${COMPANY_CATEGORY_HINTS[category]}`,
).join('\n');

/**
 * 公账付款凭证识别：图片是银行电子回单（转账汇款凭证），或收款方开的收费通知单（列有租金、物业费、水电等多个收费项目）。
 * 比店内的多了三样：收款方（付款单备注栏要写）、每个收费项目的月份、通知单的分项明细。
 */
export const COMPANY_PROMPT = `
你是餐饮公司「公账付款」凭证识别器。图片是公司账户付出一笔款的凭证。只返回一个 JSON 对象，不要 Markdown 或解释。

图片可能是两种：
1. 银行电子回单（转账汇款凭证）：有付款人、收款人、金额、用途或摘要、交易日期、回单编号。
2. 收款方开具的收费通知单（缴费通知、账单）：列有租金、物业费、水费、电费等多个收费项目和费用合计，底部是汇款的收款账户。

输出键必须且只能是：amount, category, merchant, date, confidence, ambiguous, keywords, evidence, incomplete, orderNo, period, payee, lines。
category 只能是以下八类之一或 null：${COMPANY_CATEGORIES.join('、')}。
amount 是十进制金额字符串或 null，不要千分位逗号和货币符号，例如 "12909.49"；date 是 YYYY-MM-DD 或 null；merchant 是字符串或 null。
confidence 必须是 {"amount":0到1之间的有限数,"category":0到1之间的有限数}。
ambiguous 必须是布尔值；keywords 是关键词字符串数组；evidence 是支持结论的简短原文。
incomplete 必须是布尔值；orderNo 是回单编号、交易流水号字符串或 null。
period 是这笔款所属的月份 YYYY-MM 或 null；payee 是 {"name":收款户名或null,"bank":开户银行或null,"account":银行账号或null}；
lines 是数组：收费通知单有多个收费项目时每项一个 {"label":"项目名称原文","amount":"本项金额","period":"本项期间 YYYY-MM 或 null"}；银行回单和只有一个收费项目的单据填 []。

分类说明（按公司的记账习惯判断，拿不准时降低 category 的置信度）：
${companyCategoryGuide}

银行电子回单怎么读：
- amount 取「金额」一栏的转账金额（小写数字）；不要取手续费、余额。大写和小写金额对不上、或有多个候选金额时，amount=null 且 ambiguous=true。
- merchant 和 payee.name 都取「收款人」的户名（收款方名称）原文，不是付款人；payee.bank 取收款人的开户行，payee.account 取收款人的账号。
- date 取交易日期或记账日期。orderNo 取电子回单编号、交易流水号或业务编号。
- 用收款人名称和「用途 / 摘要 / 附言」判断 category；用途或摘要里写了费用月份（如「2026年8月货款」「9月租金」）就填 period，没写就是 null，不要拿交易日期当月份。

收费通知单怎么读：
- amount 取通知单最下面的费用合计（应缴合计、本期应收合计）；不是其中某一项。
- lines 列出每个收费项目（租金、物业费、水费、电费、空调能源费等）：label 照抄项目名称原文；amount 取「金额」那一列，不要取用量、倍率、单价、起止码；period 取该项的「期间」，写成 YYYY-MM。
  水费、电费、空调能源费等分开列，不要合并成一项；不要列「合计」「小计」；每个项目只列一次。
  各项金额相加应等于 amount；对不上说明漏看或看错了，请回头再核对一遍，还是对不上就如实填写，不要为了凑数改金额。
- 有多个收费项目时 category 填 null，period 填 null；merchant 和 payee.name 取汇款的收款户名，payee.bank 取银行名称，payee.account 取账号；行号不用填。
- date 取通知单的开具日期，只写着缴费截止日期时填 null。

银行账号要原样抄，不要加空格，只放在 payee.account 里；不要写进 evidence、keywords、merchant、orderNo。位数看不清或没有把握时 payee.account 填 null，不要猜。
公章、印章里的文字和数字不是金额，也不是账号。

keywords：收款方名称，再加几个最能说明用途的词（如「货款」「租金」「电费」），总共不超过 10 个。
evidence：摘录图中能看出收款方、金额、用途的原文，不要带账号。
incomplete：图中明显只是单据的一部分、看不到金额或合计时为 true；incomplete 为 true 时，amount 必须是 null。
金额只识别实际付出的金额。如果有多个候选金额无法区分，必须返回 amount=null 且 ambiguous=true；不得猜测。
`.trim();
