<script lang="ts">
  import type { VisibleStatus } from '@haunt/shared';
  let { status, size = 10 }: { status: VisibleStatus | 'invisible'; size?: number } = $props();
  const color = $derived(
    status === 'online' ? 'var(--success)' : status === 'idle' ? 'var(--warning)' : status === 'dnd' ? 'var(--danger)' : 'var(--text-faint)',
  );
  const label = $derived({ online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible' }[status]);
  const ring = $derived(Math.max(2, Math.round(size * 0.28)));
</script>

<span class="dot {status}" style="width:{size}px;height:{size}px;--c:{color};--ring:{ring}px" title={label} role="img" aria-label={label}></span>

<style>
  .dot {
    display: inline-block;
    border-radius: 50%;
    background: var(--c);
    flex: none;
  }
  .dot.offline,
  .dot.invisible {
    background: transparent;
    box-shadow: inset 0 0 0 var(--ring) var(--c);
  }
  .dot.dnd {
    background:
      linear-gradient(var(--bg-1), var(--bg-1)) center / 62% 24% no-repeat,
      var(--c);
  }
  .dot.idle {
    background: radial-gradient(circle at 28% 28%, var(--bg-1) 34%, var(--c) 36%);
  }
</style>
