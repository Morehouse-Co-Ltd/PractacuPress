import { useMemo, useState } from 'react';
import type { LogicChain, LogicStep, LogicSettings, ScreenLayout } from '../../types';
import {
  LOGIC_ACTIONS,
  LOGIC_CONDITIONS,
  LOGIC_TRIGGERS,
  chainIssue,
  describeChain,
  stepName,
  type StepDef,
} from '../../lib/logic';
import { blockDef, nextBlockId } from '../../lib/blocks';
import { walkBlocks } from '../../lib/blockTree';
import { Badge, Button, Callout, Field, Input, Select, Toggle } from '../ui';
import { Icon } from '../Icon';

/**
 * 思维链编辑器：把「当…发生时，如果…，就…」拆成可增删的步骤。
 * 每条链都是纯数据；结构不合法（没有触发 / 没有动作）时会标出来，
 * 保存后也不会执行——evaluateChain 会拒绝它。
 */

const KIND_LABEL: Record<LogicStep['kind'], string> = {
  trigger: '当…发生时',
  condition: '如果…',
  action: '就…',
};

function StepFieldControl({
  step,
  field,
  layout,
  onChange,
}: {
  step: LogicStep;
  field: StepDef['fields'][number];
  layout: ScreenLayout;
  onChange: (config: Record<string, string | number | boolean>) => void;
}) {
  const id = `stp-${step.id}-${field.key}`;
  const value = step.config[field.key];
  const flatBlocks = useMemo(() => {
    const list: { id: string; label: string }[] = [];
    walkBlocks(layout.blocks, (block, depth) => {
      list.push({
        id: block.id,
        label: `${'　'.repeat(depth)}${block.title || blockDef(block.type)?.name || block.type}`,
      });
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.blocks]);

  if (field.type === 'block') {
    return (
      <Field label={field.label} hint={field.hint} htmlFor={id}>
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange({ ...step.config, [field.key]: event.target.value })}
        >
          <option value="">选择组件…</option>
          <option value="*">任意组件</option>
          {flatBlocks.map((block) => (
            <option key={block.id} value={block.id}>
              {block.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (field.type === 'select') {
    return (
      <Field label={field.label} hint={field.hint} htmlFor={id}>
        <Select
          id={id}
          value={typeof value === 'string' ? value : (field.options?.[0]?.value ?? '')}
          onChange={(event) => onChange({ ...step.config, [field.key]: event.target.value })}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (field.type === 'number') {
    return (
      <Field label={field.label} hint={field.hint} htmlFor={id}>
        <Input
          id={id}
          type="number"
          min={field.min}
          max={field.max}
          value={typeof value === 'number' ? value : Number(value ?? 0) || 0}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
            onChange({ ...step.config, [field.key]: Math.min(field.max ?? 1e6, Math.max(field.min ?? -1e6, next)) });
          }}
        />
      </Field>
    );
  }

  return (
    <Field label={field.label} hint={field.hint} htmlFor={id}>
      <Input
        id={id}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange({ ...step.config, [field.key]: event.target.value })}
      />
    </Field>
  );
}

function ChainCard({
  chain,
  index,
  layout,
  onChange,
  onRemove,
}: {
  chain: LogicChain;
  index: number;
  layout: ScreenLayout;
  onChange: (chain: LogicChain) => void;
  onRemove: () => void;
}) {
  const issue = chainIssue(chain);

  const patchStep = (id: string, patch: Partial<LogicStep>) => {
    onChange({ ...chain, steps: chain.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) });
  };

  const addStep = (kind: LogicStep['kind'], type: string) => {
    const def = [...LOGIC_TRIGGERS, ...LOGIC_CONDITIONS, ...LOGIC_ACTIONS].find((item) => item.type === type);
    const config: Record<string, string | number | boolean> = {};
    for (const field of def?.fields ?? []) {
      config[field.key] = field.type === 'number' ? (field.min ?? 0) : field.type === 'select' ? (field.options?.[0]?.value ?? '') : '';
    }
    const step: LogicStep = { id: nextBlockId('stp'), kind, type, config };
    const steps = [...chain.steps];
    if (kind === 'trigger') steps.unshift(step);
    else if (kind === 'action') steps.push(step);
    else {
      const firstAction = steps.findIndex((item) => item.kind === 'action');
      if (firstAction === -1) steps.push(step);
      else steps.splice(firstAction, 0, step);
    }
    onChange({ ...chain, steps });
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>
            链条 {index + 1}
            {issue ? <Badge tone="warn">不完整</Badge> : <Badge tone="ok">就绪</Badge>}
          </h3>
          <p>{describeChain(chain)}</p>
        </div>
        <div className="row gap-8">
          <Toggle
            checked={chain.enabled}
            onChange={(next) => onChange({ ...chain, enabled: next })}
            label="启用"
          />
          <button type="button" className="icon-btn" aria-label="删除链条" onClick={onRemove}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      <div className="panel-body form-stack">
        <Field label="链条名称" htmlFor={`chain-name-${chain.id}`} hint="只给你自己看，例如“深色时高亮统计卡”。">
          <Input
            id={`chain-name-${chain.id}`}
            value={chain.name}
            maxLength={80}
            onChange={(event) => onChange({ ...chain, name: event.target.value })}
          />
        </Field>

        {chain.steps.length === 0 ? (
          <p className="field-hint">还没有步骤。先加一个「当…发生时」。</p>
        ) : (
          <div className="chain-steps">
            {chain.steps.map((step, stepIndex) => {
              const def =
                step.kind === 'trigger'
                  ? LOGIC_TRIGGERS.find((item) => item.type === step.type)
                  : step.kind === 'condition'
                    ? LOGIC_CONDITIONS.find((item) => item.type === step.type)
                    : LOGIC_ACTIONS.find((item) => item.type === step.type);
              return (
                <div className={`chain-step is-${step.kind}`} key={step.id}>
                  <div className="chain-step-head">
                    <span className="chain-step-kind">{KIND_LABEL[step.kind]}</span>
                    <strong>{stepName(step.type)}</strong>
                    {def ? <span className="faint small">{def.hint}</span> : null}
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="删除步骤"
                      onClick={() => onChange({ ...chain, steps: chain.steps.filter((item) => item.id !== step.id) })}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                  {(def?.fields ?? []).map((field) => (
                    <StepFieldControl
                      key={field.key}
                      step={step}
                      field={field}
                      layout={layout}
                      onChange={(config) => patchStep(step.id, { config })}
                    />
                  ))}
                  {stepIndex < chain.steps.length - 1 ? <span className="chain-step-arrow" aria-hidden>↓</span> : null}
                </div>
              );
            })}
          </div>
        )}

        <div className="chain-add">
          <span className="field-label">添加步骤</span>
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            <Select
              aria-label="添加触发步骤"
              value=""
              onChange={(event) => event.target.value && addStep('trigger', event.target.value)}
            >
              <option value="">当…发生时</option>
              {LOGIC_TRIGGERS.map((item) => (
                <option key={item.type} value={item.type}>
                  {item.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="添加条件步骤"
              value=""
              onChange={(event) => event.target.value && addStep('condition', event.target.value)}
            >
              <option value="">如果…</option>
              {LOGIC_CONDITIONS.map((item) => (
                <option key={item.type} value={item.type}>
                  {item.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="添加动作步骤"
              value=""
              onChange={(event) => event.target.value && addStep('action', event.target.value)}
            >
              <option value="">就…</option>
              {LOGIC_ACTIONS.map((item) => (
                <option key={item.type} value={item.type}>
                  {item.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {issue ? (
          <Callout tone="warn" icon="alert">
            {issue}
          </Callout>
        ) : null}
      </div>
    </section>
  );
}

export function ChainEditor({
  logic,
  layout,
  onChange,
}: {
  logic: LogicSettings;
  layout: ScreenLayout;
  onChange: (logic: LogicSettings) => void;
}) {
  const [nextId, setNextId] = useState(1);

  const addChain = () => {
    const chain: LogicChain = {
      id: nextBlockId('chn'),
      name: `新链条 ${nextId}`,
      enabled: true,
      steps: [],
    };
    setNextId((value) => value + 1);
    onChange({ chains: [...logic.chains, chain] });
  };

  return (
    <div className="form-stack">
      <Callout tone="info" icon="sparkle" title="思维链是纯数据，不是脚本">
        一条链 = 触发 + 条件 + 动作。运行时只读这份配置，不执行任何动态代码，因此不会更慢也不会有注入面。
        每条链触发后有 1.5 秒冷却，避免滚动或悬停把动作放成刷屏。
      </Callout>

      {logic.chains.length === 0 ? (
        <section className="panel">
          <div className="panel-body">
            <p className="field-hint">还没有思维链。例如：滚到 60% 时闪烁一次统计卡；切到深色时显示作者卡。</p>
            <Button className="mt-12" icon="plus" onClick={addChain}>
              新建思维链
            </Button>
          </div>
        </section>
      ) : (
        <>
          {logic.chains.map((chain, index) => (
            <ChainCard
              key={chain.id}
              chain={chain}
              index={index}
              layout={layout}
              onChange={(next) =>
                onChange({ chains: logic.chains.map((item) => (item.id === chain.id ? next : item)) })
              }
              onRemove={() => onChange({ chains: logic.chains.filter((item) => item.id !== chain.id) })}
            />
          ))}
          <div>
            <Button variant="secondary" icon="plus" onClick={addChain} disabled={logic.chains.length >= 20}>
              再建一条
            </Button>
            <span className="tiny faint" style={{ marginLeft: 10 }}>
              最多 20 条。
            </span>
          </div>
        </>
      )}
    </div>
  );
}
