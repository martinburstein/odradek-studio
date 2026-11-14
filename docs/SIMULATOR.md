# Model and preview controls

The 191-part Blockbench model includes the board stack, antenna, ports, OLED,
all five servos, upper links, forearm rails, gripper, hardware and stylus. It is
a low-poly kinematic replica with approximate decorative dimensions.

One Blockbench unit is 10 mm. Generic Model format 5.0, cubes, polygon meshes,
embedded PNG textures, transforms and the named joint hierarchy are supported.
Keep base → shoulder → elbow → gripper, with the jaw and tool child groups.
The app applies joint rotations; it does not execute model scripts or plugins.

Select a joint, pull its arrow, and release for a preview turn. Use 1°, 10° or
30° per full pull, precise angle entry or small nudge controls. Escape cancels
an unfinished pull. Alt-drag orbits; wheel zooms. Undo/redo affect preview poses.
The gripper is initially locked.

Desk setup uses millimeters from the arm base: X right, Y above the table,
Z forward. Adjust it for your own desk. The diagram is illustrative and cannot
establish physical target coordinates or calibration.

Session exports contain committed preview state, desk dimensions and the
embedded edited asset in `.odradek.json`. They contain no Controller identity,
qualification or movement consent. Learning exports use their separate
`.odradek-learning.json` format.

Travel labels and tip coordinates are model conventions. Neither an animation
nor a live outline proves successful physical movement or contact.
