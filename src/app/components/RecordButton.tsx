export function RecordButton({
  recording,
  arming,
  disabled,
  onClick,
}: {
  recording: boolean
  arming: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`recbtn${arming ? ' recbtn--arming' : ''}`}
      disabled={disabled || arming}
      onClick={onClick}
      aria-label={recording ? 'Stop recording' : 'Start recording'}
      title={disabled ? 'Turn on at least one input' : undefined}
    >
      <span className={`recbtn__inner${recording ? ' recbtn__inner--stop' : ''}`} />
    </button>
  )
}
