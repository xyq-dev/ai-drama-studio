import styles from "./title-writing.module.css";

/**
 * Optional short drama writing guidance with original examples. It is reference text only: nothing here is required
 * to start or continue, it is not a platform review rule, and it promises no audience result.
 */
const POINTS: ReadonlyArray<{ title: string; tip: string; example: string }> = [
  { title: "整部期待", tip: "一句话写明观众希望主角最终得到什么。",
    example: "观众期待被冤枉偷窃的面馆学徒当众洗清名声，并拿回师父留下的配方。" },
  { title: "主角目标", tip: "具体、可以通过行动完成，而不是一种心情。",
    example: "不写“想证明自己”，写“在周五评审前找到被删掉的原始数据”。" },
  { title: "阻力", tip: "写清谁出于什么利益阻止主角。",
    example: "房东想在拆迁前清空租户，所以拖着不修电路，还暗中收回备用钥匙。" },
  { title: "主角主动性", tip: "关键结果来自主角的选择和行动，不靠旁人突然解围。",
    example: "不是律师恰好路过出手，而是主角自己翻出旧合同，约对方当面对质。" },
  { title: "情绪回报", tip: "每集给观众一点可感受的回报。",
    example: "尊严恢复一步、终于被家人理解、一段关系修复，或一部分真相揭晓。" },
  { title: "信息差", tip: "分别记下观众知道什么、人物知道什么。",
    example: "观众已经看到弟弟偷偷还了债，哥哥还以为他又去赌了。" },
  { title: "反转", tip: "反转要改变行动、关系或判断，并且前文有依据。",
    example: "第 1 集出现过的旧手表，第 3 集证明“证人”当晚根本不在场。" },
  { title: "冲突升级", tip: "增加代价、缩短时间或提高选择难度，不重复同一冲突。",
    example: "从“可能被扣奖金”升级到“明早九点前不交方案就失去整个团队”。" },
  { title: "兑现", tip: "本集解决一部分问题，同时引出下一集的问题。",
    example: "拿回了录音，却发现录音里还有第三个人的声音。" },
  { title: "台词", tip: "台词表达人物意图，不重复解释画面已经演出来的事。",
    example: "不写“我很生气，因为你骗了我”，写“钥匙给我。今晚你睡店里”。" },
];

export function EpisodeWritingGuidance({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <details className={styles.more} open={defaultOpen}>
      <summary>编剧指导（可选参考）</summary>
      <p className={styles.helper}>
        写作参考，不是必填步骤，也不是平台审核规则，不保证播放效果。题材和人物按故事本身设计，不按性别预设套路。
      </p>
      <ol className={styles.guidance}>
        {POINTS.map((point) => (
          <li key={point.title}>
            <p className={styles.guidanceTitle}>{point.title}：{point.tip}</p>
            <p className={styles.guidanceExample}>示例：{point.example}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
