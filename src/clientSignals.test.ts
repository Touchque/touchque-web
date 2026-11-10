import { describe, test, expect, afterEach } from 'vitest';
import { startClientSignals, addAgentTrap, agentTrapState, AGENT_TRAP_ATTRIBUTE } from './clientSignals';

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__playwright;
});

describe('startClientSignals', () => {
  test('script-made events, a field filled by script and automation artefacts show; nothing typed is kept', () => {
    document.body.innerHTML = '<form><input id="email"><input id="pw" type="password"><input type="hidden" value="x"></form>';
    const probe = startClientSignals();
    (window as unknown as Record<string, unknown>).__playwright = {};
    (document.getElementById('email') as HTMLInputElement).value = 'ada@acme.com';
    const pw = document.getElementById('pw') as HTMLInputElement;
    pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    pw.value = 'secret';
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 3, clientY: 4 }));
    const s = probe.collect();
    expect(s.v).toBe(1);
    expect(s.art).toContain('__playwright');
    expect(s.ev.key).toBe(1);
    expect(s.ev.clicks).toBe(1);
    expect(s.ev.untrusted).toBe(2);
    expect(s.fill).toBe(1);
    expect(JSON.stringify(s)).not.toContain('secret');
    expect(JSON.stringify(s)).not.toContain('ada@acme.com');
    const decoded = JSON.parse(Buffer.from(probe.encode(), 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ v: 1, fill: 1 });
    probe.stop();
  });

  test('an agent trap: absent on pages without one, 0 while empty, 1 with its note\'s word, 2 with anything else; never counted as a field filled by script', () => {
    document.body.innerHTML = '<form id="f"><input id="email"></form>';
    const probe = startClientSignals();
    expect(probe.collect().trap).toBeUndefined();
    const form = document.getElementById('f') as HTMLFormElement;
    const trap = addAgentTrap(form);
    expect(addAgentTrap(form)).toBe(trap);
    expect(trap.hasAttribute(AGENT_TRAP_ATTRIBUTE)).toBe(true);
    expect(trap.tabIndex).toBe(-1);
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(probe.collect()).toMatchObject({ trap: 0, fill: 0 });
    trap.value = 'Ada Lovelace';
    expect(probe.collect()).toMatchObject({ trap: 2, fill: 0 });
    trap.value = 'agent';
    expect(probe.collect()).toMatchObject({ trap: 1, fill: 0 });
    expect(JSON.stringify(probe.collect())).not.toContain('agent"');
    expect([agentTrapState([' "Agent". ']), agentTrapState(['', '']), agentTrapState(['acme corp'])]).toEqual([1, 0, 2]);
    probe.stop();
  });

  test('a value the page set itself (a read-only email echo, the server\'s value) is not a fill', () => {
    document.body.innerHTML = '<form><input id="echo" type="email" value="ada@acme.com" readonly><input id="pre" value="from the server"><input id="pw" type="password"></form>';
    const probe = startClientSignals();
    expect(probe.collect().fill).toBe(0);
    (document.getElementById('pw') as HTMLInputElement).value = 'set by a script';
    expect(probe.collect().fill).toBe(1);
    probe.stop();
  });

  test('a held key (auto-repeat) is counted but left out of the typing rhythm', () => {
    document.body.innerHTML = '<form><input id="email"></form>';
    const probe = startClientSignals();
    const email = document.getElementById('email') as HTMLInputElement;
    for (let i = 0; i < 10; i += 1) email.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', repeat: i > 0, bubbles: true }));
    const s = probe.collect();
    expect(s.ev.key).toBe(10);
    expect(s.t.keyMean).toBeNull();
    probe.stop();
  });
});
