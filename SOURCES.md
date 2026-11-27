# 数据来源、许可与系统边界

- **公开电影资料集**：[NiklasAbraham/MoviePlotEmbeddingsDataset](https://huggingface.co/datasets/NiklasAbraham/MoviePlotEmbeddingsDataset)，数据集卡标注许可为 **CC BY-NC 4.0**。本项目仅作非商业课程演示与学术调研用途。
- **上游字段归属**：据数据集卡说明，字段整合自 Wikidata（CC0）、Wikipedia（CC BY-SA 4.0）与 TMDb（CC BY-NC 4.0）。V4 Pro 完整保留全部 **92,374 条**（1930–2024 年）含完整剧情的记录（含 2,388 部纯国产、207 部中外合拍、89,779 部国外电影，86,598 条导演、5,058 条获奖记录、91,006 条 IMDb 链接及 1,314 条中文片名补充），以双 Gzip 分片打包为 `data/catalog_1.pack`（14.97 MB）与 `data/catalog_2.pack`（12.36 MB），总计约 27.33 MB。
- **海报来源**：网页卡片中的真实电影海报按需从 Wikipedia 公开 REST Summary API（`en.wikipedia.org/api/rest_v1/page/summary/`）实时加载，无法获取或离线时优雅回退为本地生成的艺术排版封面，不缓存或再分发受版权限制的海报原图。
- **评分与时效说明**：评分字段为数据集中 TMDb `vote_average` 历史快照（0–10 分制），并非实时评分，也不代表本项目主观打分。
- **云端模型与隐私边界**：
  - **GitHub Pages 静态公开版**：100% 在用户浏览器本地并行解压双分片运行，**不含任何 API Key 输入表单，不调用云端 LLM**（仅按需从 Wikipedia 加载公开海报缩略图）。
  - **本机 Python 服务版**：默认纯本地离线检索；仅当用户在「云端 RAG 设置」中主动填入个人 API Key 并勾选启用云端 RAG 时，才会将 Top-6 检索证据与问题发送至所配置的 Gemini 或 OpenAI 兼容服务商，且严格闭卷核验 `[QID]` 引用。密钥仅暂存本机内存，不落盘、不写日志。
- **隐私与学术诚信**：本项目不包含任何学生个人资料、私有聊天记录或真实用户调研伪造数据。
