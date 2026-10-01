import { CATEGORIES, type Category } from '@auto-reimbursement/contracts';

/**
 * 每个分类一句业务说明（门店的记账习惯）。只给分类名时 AI 分不清「百慕达食材」和「食材」，
 * 试点里武汉仓的订单一直被归成食材。以后多店时可挪进设置、按门店配置。
 */
export const CATEGORY_HINTS: Record<Category, string> = {
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
