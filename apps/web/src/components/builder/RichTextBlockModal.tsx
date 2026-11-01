import { useEffect, useMemo, useState } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import { renderMarkdown } from '../../lib/markdown';
import { RichTextEditor } from '../RichTextEditor';
import { Button, Modal } from '../ui';

/**
 * 文本块的富文本编辑弹窗。
 *
 * 复用文章编辑器的 contenteditable 工具链；存盘时仍转成 Markdown 放进 props.body，
 * 前台用现有 Markdown 渲染与清洗器输出，不把任意 HTML 直接塞进页面。
 */
export function RichTextBlockModal({
  block,
  onClose,
  onSave,
}: {
  block: BlockInstance | null;
  onClose: () => void;
  onSave: (markdown: string) => void;
}) {
  const [markdown, setMarkdown] = useState('');
  const initial = block ? blockProp<string>(block, 'body', '') : '';
  const initialHtml = useMemo(() => renderMarkdown(initial), [initial]);

  useEffect(() => {
    if (!block) return;
    setMarkdown(blockProp<string>(block, 'body', ''));
  }, [block]);

  return (
    <Modal
      open={!!block}
      title="编辑富文本"
      description="支持标题、粗体、列表、链接、图片、表格、分栏和公式。内容以 Markdown 保存。"
      onClose={onClose}
      width={1000}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              onSave(markdown);
              onClose();
            }}
          >
            保存到文本块
          </Button>
        </>
      }
    >
      {block ? (
        <RichTextEditor
          initialHtml={initialHtml}
          revision={block.id}
          onChange={(next) => setMarkdown(next)}
          placeholder="写标题、正文、图片或分栏…"
        />
      ) : null}
    </Modal>
  );
}
