import { useState } from "react";
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
  Star,
  Tag as TagIcon,
  X,
} from "lucide-react";

interface Props {
  selectedCount: number;
  tags: string[];
  language: string;
  busy: boolean;
  onClose: () => void;
  onSetTag: (tag: string) => void;
  onSetShowFlag: (show: boolean) => void;
  onSetFeatured: (featured: boolean) => void;
}

/* ─── 折叠区块（与本地资源库批量整理面板保持一致） ─── */

function Section({
  label,
  icon: Icon,
  open,
  onToggle,
  children,
}: {
  label: string;
  icon: typeof TagIcon;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className="border-b px-5 py-1"
      style={{ borderColor: "var(--border)" }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 py-2.5 text-left"
      >
        <Icon size={14} strokeWidth={1.8} style={{ color: "var(--muted-foreground)" }} />
        <span
          className="flex-1 text-[12.5px] font-semibold"
          style={{ color: "var(--foreground)" }}
        >
          {label}
        </span>
        <ChevronDown
          size={14}
          className="transition-transform duration-200"
          style={{
            color: "var(--muted-foreground)",
            transform: open ? "rotate(0deg)" : "rotate(-90deg)",
          }}
        />
      </button>
      {open && <div className="pb-4">{children}</div>}
    </section>
  );
}

/**
 * 云端资源库多选照片的「批量整理」浮动面板。
 * 交互与本地资源库的 LocalAssetBatchDetails 一致：
 * 悬浮在内容区右下角，支持批量设置标签、画廊显示/隐藏与精选。
 *
 * 标签交互：点击标签列表加入输入框（chip），chip 上的 x 移除；
 * 也可直接输入新标签回车加入；点「应用」后把输入框内的标签
 * （逗号拼接，服务端整体替换）批量应用到全部选中照片。
 */
export function CloudBatchOrganizePanel({
  selectedCount,
  tags,
  language,
  busy,
  onClose,
  onSetTag,
  onSetShowFlag,
  onSetFeatured,
}: Props) {
  const zh = language === "zh";
  const [tagOpen, setTagOpen] = useState(true);
  const [galleryOpen, setGalleryOpen] = useState(true);
  const [featuredOpen, setFeaturedOpen] = useState(true);
  // 输入框内的标签 chips（尚未应用到照片）
  const [pendingTags, setPendingTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  const addPendingTag = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPendingTags((prev) =>
      prev.includes(trimmed) ? prev : [...prev, trimmed],
    );
  };

  const removePendingTag = (name: string) => {
    if (busy) return;
    setPendingTags((prev) => prev.filter((item) => item !== name));
  };

  return (
    <aside
      className="custom-scrollbar absolute bottom-14 right-3 z-40 flex max-h-[min(680px,calc(100%-7rem))] w-[320px] flex-col overflow-y-auto rounded-xl border bg-background shadow-[0_16px_40px_-20px_rgba(15,23,42,0.72)]"
      style={{ borderColor: "var(--border)" }}
    >
      {/* ── 头部：批量整理 + 已选数量 + 关闭 ── */}
      <div
        className="flex items-center gap-2.5 border-b px-5 py-4"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold" style={{ color: "var(--foreground)" }}>
            {zh ? "批量整理" : "Batch organize"}
          </h2>
          <p
            className="mt-0.5 text-[11px] tabular-nums"
            style={{ color: "var(--muted-foreground)" }}
          >
            {zh ? `已选 ${selectedCount} 项` : `${selectedCount} selected`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={zh ? "关闭" : "Close"}
          className="flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-secondary"
          style={{ color: "var(--muted-foreground)" }}
        >
          <X size={14} />
        </button>
      </div>

      {/* ── 标签：点击/输入加入输入框，点「应用」批量生效 ── */}
      <Section
        label={zh ? "标签" : "Tags"}
        icon={TagIcon}
        open={tagOpen}
        onToggle={() => setTagOpen((v) => !v)}
      >
        <div className="space-y-3">
          {/* 标签输入框：chips + 文本输入 */}
          <div
            className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border px-1.5 py-1"
            style={{ borderColor: "var(--border)" }}
          >
            {pendingTags.map((name) => (
              <span
                key={name}
                className="flex max-w-full items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10px]"
                style={{ color: "var(--foreground)" }}
              >
                <span className="min-w-0 truncate">{name}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removePendingTag(name)}
                  title={zh ? `移除 ${name}` : `Remove ${name}`}
                  aria-label={zh ? `移除 ${name}` : `Remove ${name}`}
                  className="flex shrink-0 items-center rounded transition-colors hover:opacity-70 disabled:opacity-50"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  <X size={9} />
                </button>
              </span>
            ))}
            <input
              value={tagInput}
              disabled={busy}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "," || event.key === "，") {
                  // 回车/逗号：把输入内容作为新标签加入输入框
                  event.preventDefault();
                  if (!busy && tagInput.trim()) {
                    addPendingTag(tagInput);
                    setTagInput("");
                  }
                } else if (
                  event.key === "Backspace" &&
                  !tagInput &&
                  pendingTags.length > 0 &&
                  !busy
                ) {
                  // 退格删除最后一个 chip
                  event.preventDefault();
                  setPendingTags((prev) => prev.slice(0, -1));
                }
              }}
              placeholder={
                pendingTags.length === 0
                  ? zh
                    ? "输入新标签，回车加入"
                    : "Type a tag, Enter to add"
                  : ""
              }
              className="h-6 min-w-20 flex-1 bg-transparent text-[11px] outline-none"
              style={{ color: "var(--foreground)" }}
            />
          </div>

          {/* 已有标签列表：点击加入/移出输入框 */}
          {tags.length > 0 ? (
            <div className="custom-scrollbar max-h-36 space-y-0.5 overflow-y-auto">
              {tags.map((tag) => {
                const active = pendingTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      active
                        ? removePendingTag(tag)
                        : addPendingTag(tag)
                    }
                    title={
                      active
                        ? zh
                          ? `从输入框移除：${tag}`
                          : `Remove from input: ${tag}`
                        : zh
                          ? `加入输入框：${tag}`
                          : `Add to input: ${tag}`
                    }
                    className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    <TagIcon
                      size={11}
                      className="shrink-0"
                      style={{ color: "var(--muted-foreground)" }}
                    />
                    <span
                      className="min-w-0 flex-1 truncate"
                      style={{ color: "var(--foreground)" }}
                    >
                      {tag}
                    </span>
                    <Check
                      size={12}
                      className={`shrink-0 transition-opacity ${
                        active ? "opacity-100" : "opacity-0 group-hover:opacity-50"
                      }`}
                      style={{ color: "var(--primary)" }}
                    />
                  </button>
                );
              })}
            </div>
          ) : (
            <p
              className="text-[10px] italic"
              style={{ color: "var(--muted-foreground)" }}
            >
              {zh ? "暂无已有标签，可直接输入新标签" : "No tags yet, type new ones"}
            </p>
          )}

          {/* 应用：把输入框内的标签整体替换到全部选中照片 */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || pendingTags.length === 0}
              onClick={() => onSetTag(pendingTags.join(","))}
              className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                backgroundColor: "var(--primary)",
                color: "var(--primary-foreground)",
              }}
            >
              <Check size={11} />
              {zh
                ? `应用${pendingTags.length > 0 ? `（${pendingTags.length}）` : ""}`
                : `Apply${pendingTags.length > 0 ? ` (${pendingTags.length})` : ""}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPendingTags([]);
                onSetTag("");
              }}
              title={zh ? "清除所选照片的全部标签" : "Clear all tags"}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors hover:bg-secondary disabled:opacity-40"
              style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
            >
              <X size={11} />
              {zh ? "清除" : "Clear"}
            </button>
          </div>
          <p
            className="text-[10px] leading-relaxed"
            style={{ color: "var(--muted-foreground)" }}
          >
            {zh
              ? pendingTags.length > 0
                ? `应用后将所选照片的标签替换为以上 ${pendingTags.length} 项`
                : "点击或输入标签加入输入框，再点「应用」生效"
              : pendingTags.length > 0
                ? `Applying replaces the tags of selected photos with the ${pendingTags.length} above`
                : "Pick or type tags, then press Apply"}
          </p>
        </div>
      </Section>

      {/* ── 画廊可见性 ── */}
      <Section
        label={zh ? "画廊可见性" : "Gallery visibility"}
        icon={Eye}
        open={galleryOpen}
        onToggle={() => setGalleryOpen((v) => !v)}
      >
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetShowFlag(true)}
            className="flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-all active:scale-[0.98] disabled:opacity-40"
            style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
          >
            <Eye size={12} />
            {zh ? "设为展示" : "Show"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetShowFlag(false)}
            className="flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-all active:scale-[0.98] disabled:opacity-40"
            style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
          >
            <EyeOff size={12} />
            {zh ? "设为隐藏" : "Hide"}
          </button>
        </div>
      </Section>

      {/* ── 精选 ── */}
      <Section
        label={zh ? "精选" : "Featured"}
        icon={Star}
        open={featuredOpen}
        onToggle={() => setFeaturedOpen((v) => !v)}
      >
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetFeatured(true)}
            className="flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-all active:scale-[0.98] disabled:opacity-40"
            style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
          >
            <Star size={12} fill="currentColor" style={{ color: "#F59E0B" }} />
            {zh ? "添加到精选" : "Feature"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetFeatured(false)}
            className="flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-all active:scale-[0.98] disabled:opacity-40"
            style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
          >
            <Star size={12} />
            {zh ? "取消精选" : "Unfeature"}
          </button>
        </div>
      </Section>

      {/* ── 保存中提示 ── */}
      {busy && (
        <div
          className="flex items-center justify-center gap-1.5 px-5 pb-5 pt-4 text-[10px]"
          style={{ color: "var(--muted-foreground)" }}
        >
          <Loader2 size={10} className="animate-spin" />
          {zh ? "正在保存..." : "Saving..."}
        </div>
      )}
    </aside>
  );
}
