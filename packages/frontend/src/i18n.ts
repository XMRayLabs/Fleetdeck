import { createI18n, Composer } from 'vue-i18n';
import { aiMessages, agentMessages } from './locales/ai';
import { opsMessages } from './locales/ops';

// 动态导入 locales 目录下的所有 .json 文件
// 使用 { eager: true } 确保同步加载，因为 i18n 实例需要在应用初始化时就绪
// 使用 { import: 'default' } 直接获取模块的默认导出
const localeModules = import.meta.glob('./locales/*.json', { eager: true, import: 'default' });

// 构建 messages 对象和可用语言列表
const messages: Record<string, any> = {};
const availableLocales: string[] = [];

for (const path in localeModules) {
  // 从路径中提取语言代码 (例如 './locales/en.json' -> 'en')
  const locale = path.match(/.\/locales\/(.+)\.json$/)?.[1];
  if (locale) {
    messages[locale] = localeModules[path]; // 获取导入的 JSON 内容
    const ai = aiMessages[locale as keyof typeof aiMessages];
    if (ai) {
      messages[locale].ai = ai;
      messages[locale].ai.contextHint = locale === 'zh-CN' ? '手动附加日志，最多 64,000 字；会与对话摘要、所选设备及勾选的上下文一起进入脱敏预览。' : locale === 'ja-JP' ? '手動添付ログは最大 64,000 文字。会話要約、対象デバイス、選択した情報源と共に確認できます。' : 'Manually attached logs, up to 64,000 characters, join conversation summaries, selected devices and opted-in sources in the redacted preview.';
      messages[locale].ops = opsMessages[locale as keyof typeof opsMessages];
      messages[locale].ops.autoReview = locale === 'zh-CN' ? '执行完成后自动准备复查（仍需确认发送）' : locale === 'ja-JP' ? '完了後に再分析を準備（送信は要承認）' : 'Prepare review after execution (sending still requires approval)';
      messages[locale].ops.limits = locale === 'zh-CN' ? '每个计划最多 5 轮 / 15 分钟；每轮都需人工确认' : locale === 'ja-JP' ? '計画ごとに最大 5 回 / 15 分。毎回承認が必要' : 'Up to 5 rounds / 15 minutes per plan; approval required every round';
      messages[locale].ui.pages.Monitoring = messages[locale].ops.description;
      messages[locale].agent = agentMessages[locale as keyof typeof agentMessages];
      messages[locale].agent.saveFirst = locale === 'zh-CN' ? '请先保存新的 API / 模型设置。' : locale === 'ja-JP' ? '変更した API / モデル設定を先に保存してください。' : 'Save the changed API / model settings first.';
      messages[locale].ui.pages.AiAssistant = ai.description;
    }
    availableLocales.push(locale);
  }
}

// 检查是否成功加载了任何语言文件
if (availableLocales.length === 0) {
  console.error("[i18n] No language files found in './locales/'. Please ensure language files exist and the path is correct.");
}

// 类型推断 (基于第一个加载的语言文件，假设所有文件结构一致)
// 如果没有加载到文件，则使用空对象作为 fallback，避免运行时错误
// 使用更通用的类型 Record<string, any> 来避免动态索引的类型推断问题
// 尝试一个更具体的类型来帮助 TypeScript 推断，以解决深层实例化问题
// 这允许嵌套的翻译键，例如 'parent.child.grandchild'
interface RecursiveStringRecord {
  [key: string]: string | RecursiveStringRecord;
}
type MessageSchema = RecursiveStringRecord;

// 定义默认语言 (优先使用 'en-US'，如果不存在则使用第一个找到的语言)
export const defaultLng = availableLocales.includes('en-US') ? 'en-US' : availableLocales[0] || 'en-US'; // 更新为 en-US
const localStorageKey = 'user-locale';

// 尝试从 localStorage 获取语言，否则回退
const getInitialLocale = (): string => {
  const storedLocale = localStorage.getItem(localStorageKey);
  // 1. 检查 localStorage 中存储的完整 locale 是否可用
  if (storedLocale && availableLocales.includes(storedLocale)) {
    console.log(`[i18n] Using locale from localStorage: ${storedLocale}`);
    return storedLocale;
  }

  // 2. 回退逻辑：检查浏览器提供的完整区域代码 (e.g., 'zh-CN') 是否可用
  const navigatorLocale = navigator.language; // 获取完整代码，如 'zh-CN'
  if (navigatorLocale && availableLocales.includes(navigatorLocale)) {
    console.log(`[i18n] Using locale from navigator.language: ${navigatorLocale}`);
    return navigatorLocale;
  }

  // 3. (可选，但更健壮) 检查浏览器语言的主语言部分 (e.g., 'zh') 是否可用
  //    这在只有 'zh-CN' 但浏览器是 'zh-TW' 时可能有用，如果想回退到 'en' 而不是 'zh-CN'
  //    或者如果我们未来添加了通用的 'zh' 文件
  const navigatorLangPart = navigatorLocale?.split('-')[0];
  if (navigatorLangPart && availableLocales.includes(navigatorLangPart)) {
      console.log(`[i18n] Using locale based on navigator language part: ${navigatorLangPart}`);
      return navigatorLangPart;
  }

  // 4. 最后回退到默认语言
  console.log(`[i18n] Falling back to default locale: ${defaultLng}`);
  return defaultLng;
};


const i18n = createI18n<[MessageSchema], string>({ // 使用 string 作为 locale 类型，因为它是动态的
  legacy: false, // 必须设置为 false 才能在 Composition API 中使用 useI18n
  locale: getInitialLocale(), // 使用计算得到的初始语言
  fallbackLocale: defaultLng, // 如果当前语言缺少某个 key，则回退到默认语言
  messages: messages, // 使用动态构建的 messages 对象
  // 可选：关闭控制台的 i18n 警告 (例如缺少 key 的警告)
  // silentTranslationWarn: true,
  // silentFallbackWarn: true,
});

/**
 * 设置 i18n 实例的区域设置
 * @param lang 要设置的语言代码
 */
export const setLocale = (lang: string) => {
  console.log(`[i18n] Attempting to set locale to: ${lang}`);
  const globalComposer = i18n.global as unknown as Composer;
  // 使用动态获取的可用语言列表进行检查
  if (availableLocales.includes(lang)) {
    const currentLocale = globalComposer.locale.value;
    if (currentLocale !== lang) {
        globalComposer.locale.value = lang; // 更新 locale
        console.log(`[i18n] Successfully updated global locale from "${currentLocale}" to "${lang}".`);
        try {
          localStorage.setItem(localStorageKey, lang); // 持久化到 localStorage
          console.log(`[i18n] Locale "${lang}" saved to localStorage.`);
        } catch (e) {
          console.error('[i18n] Failed to save locale to localStorage:', e);
        }
    } else {
        console.log(`[i18n] Locale is already "${lang}". No update needed.`);
    }
  } else {
    console.warn(`[i18n] Locale "${lang}" is not available. Available locales: ${availableLocales.join(', ')}`);
  }
};

// 导出可用语言列表，方便其他地方使用 (例如语言选择器)
export { availableLocales };

export default i18n;
