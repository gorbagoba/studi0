import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { PromptDialog } from './PromptDialog';
import { installDialogPolyfill } from '../testing/dialogPolyfill';

installDialogPolyfill();

function ConfirmHarness({
  onConfirm,
  onClose,
}: {
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      title="Delete group MATH?"
      body="1 subject becomes ungrouped."
      confirmLabel="Delete"
      danger
      onConfirm={() => {
        onConfirm();
        setOpen(false);
      }}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
    />
  );
}

function PromptHarness({
  onSubmit,
  mustMatch,
}: {
  onSubmit: (v: string) => Promise<void>;
  mustMatch?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <PromptDialog
      open={open}
      title="Rename subject"
      label="Name"
      initialValue="Linear Algebra"
      submitLabel="Rename"
      mustMatch={mustMatch}
      onSubmit={async (v) => {
        await onSubmit(v);
        setOpen(false);
      }}
      onClose={() => setOpen(false)}
    />
  );
}

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('confirms from the confirm button', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} onClose={onClose} />);
    expect(screen.getByText('1 subject becomes ungrouped.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('cancels from the cancel button and Escape without confirming', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled(); // native close re-fires the idempotent onClose

    render(<ConfirmHarness onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled(); // native close re-fires the idempotent onClose
  });
});

describe('PromptDialog', () => {
  it('submits the trimmed value once it differs from the initial one', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<PromptHarness onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    expect(input.value).toBe('Linear Algebra');
    const submit = screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // unchanged value
    fireEvent.change(input, { target: { value: '  Linear Algebra II  ' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Linear Algebra II'));
  });

  it('stays disabled until the typed value echoes mustMatch exactly', () => {
    const onSubmit = vi.fn(async () => {});
    render(<PromptHarness onSubmit={onSubmit} mustMatch="Linear Algebra" />);
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    const submit = screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'linear algebra' } });
    expect(screen.getByText(/Type “Linear Algebra” exactly/)).toBeTruthy();
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Linear Algebra' } });
    expect(submit.disabled).toBe(false);
  });

  it('keeps the dialog open and shows the error when onSubmit rejects', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('name taken');
    });
    render(<PromptHarness onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText(/name taken/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
