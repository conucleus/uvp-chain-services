const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/;
const DISPLAYABLE_UNICODE_PATTERN =
  /^[\p{Letter}\p{Number}\p{Punctuation}\p{Separator}]+$/u;

/**
 * bytes32 展示解码单源（审计 §1.1 "bytes32 展示解码 ×2" / §3 P1-4）。
 * 此前链轨服务内有两份私有实现，接受集相反导致同一标识两副面孔：
 * - 阶段视图（product/application）：去尾部零字节 + 仅接受可打印 ASCII
 *   ——中文标识被判不可展示，回落短哈希；
 * - 通知/活动流（notifications）：首个 NUL 截断 + 接受 Unicode
 *   Letter/Number/Punctuation/Separator——中文可展示，但 "$ + = < > ^
 *   ` | ~" 等 ASCII 符号被拒。
 * 统一为并集语义：按 Solidity 字符串惯例在首个 NUL 截断、utf8 解码并
 * 去首尾空白后，文本整体落在「可打印 ASCII」或「Unicode
 * Letter/Number/Punctuation/Separator」任一字符集即视为可展示。因此
 * 中文与 "$=|^~" 类符号标识在所有视图一致显示文本；全零、解码为空、
 * 含控制字符或乱码字节序列一律判不可展示，交由调用方回落。
 * 非 bytes32 输入不在此解码（返回 undefined），由展示函数原样透传。
 */
export function decodeBytes32Text(value: string): string | undefined {
  if (!BYTES32_PATTERN.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value.slice(2), "hex");
  const end = bytes.indexOf(0);
  const text = (end >= 0 ? bytes.subarray(0, end) : bytes)
    .toString("utf8")
    .trim();
  if (text.length === 0) {
    return undefined;
  }
  return PRINTABLE_ASCII_PATTERN.test(text) ||
      DISPLAYABLE_UNICODE_PATTERN.test(text)
    ? text
    : undefined;
}

/** bytes32/长哈希的短形态（8+8，沿用阶段视图既有 shortHex 口径）。 */
export function shortBytes32(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 8)}...${value.slice(-8)}`
    : value;
}

/**
 * bytes32 展示单源：
 * - 空值 → fallback（既有两份实现的公共分支）；
 * - 非 bytes32 → 原样透传（通知流对已解码/外部标识的既有行为）；
 * - 可解码 → 解码文本（并集语义，见 decodeBytes32Text）；
 * - 不可解码 → 带 fallback 标签时 `${fallback} ${短哈希}`（阶段视图
 *   proofRows/名称字段既有形态），无标签时裸短哈希（通知流 stageId
 *   技术字段既有形态）。
 */
export function displayBytes32(value: string | undefined, fallback = ""): string {
  if (!value) {
    return fallback;
  }
  if (!BYTES32_PATTERN.test(value)) {
    return value;
  }
  const text = decodeBytes32Text(value);
  if (text !== undefined) {
    return text;
  }
  return fallback ? `${fallback} ${shortBytes32(value)}` : shortBytes32(value);
}
