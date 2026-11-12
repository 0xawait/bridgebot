## 项目概述
基于 grammy 框架的 Telegram 双向机器人。

## 数据库规范（必须遵守）
- **表名前缀**：所有创建的数据表**必须**统一带前缀 `sk_`。
- **必备字段**：每张表必须包含 `created_at`（默认 `CURRENT_TIMESTAMP`）、`updated_at`（默认 `CURRENT_TIMESTAMP`，`ON UPDATE CURRENT_TIMESTAMP`）。
- **字符集与排序规则**：建表必须显式指定 `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`；连接层必须显式指定 `charset=utf8mb4`。
- **字段设计**：禁止冗余字段与重复语义字段；布尔语义**必须**使用 `enum`（如 `enum('enable','disable')`），禁止使用 `tinyint(1)` 等其他类型；金额、计数等数值字段选用足够精度，禁止用浮点类型存金额。
- **索引约束**：仅为高频查询的过滤、排序、关联字段建索引，优先联合索引并遵循最左前缀；禁止给低基数字段建单独索引；单表索引总数不超过 5 个（不含主键）。
- **变更流程**：任何表结构变更必须在 `README.md` 中补充对应 SQL 补丁，并同步更新初始化脚本 `script/initDB.js`，保证初始化脚本与线上结构一致。
- **SQL 使用**：业务代码统一通过 `src/services/mysqlService.ts` 的连接池与事务方法访问数据库，禁止在业务层自行创建连接；所有 SQL 必须使用参数化占位符，禁止字符串拼接用户输入。