# Hardware integration scope

The simulator and Learning Lab work without any hardware. Real device controls
are provided for a Waveshare RoArm-M2-S through the existing local Controller;
they remain a developer-preview integration. A new computer or arm needs its
own device identity, geometry, qualification and measured starting state.
The distribution includes no owner's profile, private authorization, saved
physical targets or commissioning evidence.

For the manufacturer's setup, interfaces and USB driver resources, consult the
[official RoArm-M2-S guide](https://www.waveshare.com/wiki/RoArm-M2-S).
Its ESP32 serial USB interface is distinct from the board's other USB port.
This Studio release does not flash firmware or supply a firmware experiment.

Manual uses measured feedback and explicit Move actions. Automatic's offline
Motion Lab designs previews; physical execution has its separate Controller
checks. Stop & disarm, Repair Controller and clean service restart retain their
existing roles. Repair does not replay a movement, record an inspection or
power-cycle the robot.

Camera support is optional and requires a separate local Python camera helper.
Frames remain in memory. A camera image cannot establish device qualification,
calibration or current human supervision.

Downloading the application, opening a session or watching a learned policy
does not commission a robot. Physical contact, pressure control and computer
input by the arm remain unvalidated by the bundled simulation examples.
