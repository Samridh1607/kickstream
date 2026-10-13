import { Field, Select } from "@fluentui/react-components";
import type { Devices } from "./useDevices";

export function DevicePickers({ devices }: { devices: Devices }) {
  return (
    <>
      <Field label="Camera">
        <Select value={devices.camera ?? ""} onChange={(_, data) => void devices.chooseCamera(data.value === "" ? null : data.value)}>
          <option value="">Camera off</option>
          {devices.cameras.map((device) => (
            <option key={device.id} value={device.id}>{device.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Microphone">
        <Select value={devices.microphone ?? ""} disabled={devices.microphones.length === 0}
          onChange={(_, data) => void devices.chooseMicrophone(data.value)}>
          {devices.microphones.map((device) => (
            <option key={device.id} value={device.id}>{device.name}</option>
          ))}
        </Select>
      </Field>
    </>
  );
}
