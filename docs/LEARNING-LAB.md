# Learning Lab

Open the dedicated Learning Lab shortcut for a cold offline launch. It starts
the renderer without the Controller, Studio device services or camera. From the
ordinary app, use Application → Stylus Learning · offline.

## Replay and iteration ghosts

Select an included study and load it. Revised corner practice is the default.
Watch evolution tours retained policies from early to later generations.
Show iteration ghosts instead overlays the saved generations at one shared
trial time, with the selected solid arm in front. Turning it on selects the
latest saved solid policy and loops its trial until paused.

The default example has 82 saved best-policy generations and 800 generation
scores. Pink ghosts are earlier; cyan ghosts are later. Change the Attempt
selector to compare saved winners or worst candidates. A low-ranked candidate
is not automatically a failed contact: the simulated metrics determine that.
Failed evaluations without a valid trajectory are counted and not fabricated.
Very large imports explicitly report the 256-ghost display limit.

Play/Pause and the time scrubber affect every ghost. Ghost visibility adjusts
transparency. Hide controls makes room for the scene; compact controls retain
Ghosts, Play and Frame. Frame includes actual ghost arm bounds throughout the
selected trial. Leaving Learning Lab restores the Manual pose, desk and camera.

Trial detail plots sampled tip speed, tip gap and modeled load against time.
Metric cards cover the whole integration. Amber is target, cyan is contact,
red is missed contact/dig/collision, and violet is approach/lift.

## Train, save and move between computers

Under Train, choose seed, population and generation limit, then set the tool
reach and mounting assumptions. Start new run performs software trials only.
The limit is an upper bound; a run can stop at a plateau while still missing
targets. Its status displays the actual stop reason.

Pause & save preserves the exact unfinished optimizer and random state.
Resume saved run continues it. Export run writes `.odradek-learning.json` for
another Studio installation. The file carries the supported model and saved
policies; it carries no physical movement permission or machine credentials.
Included studies are examples; they do not replace your own saved archive.

Normal close, reload and service repair wait for the newest learner checkpoint.
If a save fails, export the latest paused run before replacing it. Forced
termination or power loss can recover only the last completed checkpoint.

## What the results mean

The three positioning joints balance tip position against working angle; the
gripper is fixed during learning. The model has approximate collisions and
assumed compliance. `N*` is not measured force. The reference working-angle map
describes nominal geometry, not the learned policy or guaranteed clearance.
Examples and inspected test paths are exploratory simulation data. No physical
trackpad control is established by a successful replay.
