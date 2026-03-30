/**
 * 与 dotenv 常见写法兼容：1 / true / yes / on（忽略首尾空白，大小写不敏感）
 */
function envTruthy(key) {
  const v = String(process.env[key] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

module.exports = { envTruthy };
