import { useEffect, useState } from "react";
import type { Device, RoomCall } from "./RoomCall";

export const deviceProblem = (caught: unknown) =>
  `Your camera or microphone could not be used (${caught instanceof Error ? caught.message : "unknown reason"}). You can still join with them off.`;

export interface Devices {
  cameras: Device[];
  microphones: Device[];
  camera: string | null;
  microphone: string | null;
  problem: string | null;
  chooseCamera(deviceId: string | null): Promise<void>;
  chooseMicrophone(deviceId: string): Promise<void>;
}

/** The call's cameras and microphones. The first of each is turned on once the call exists. */
export function useDevices(call: RoomCall | null): Devices {
  const [cameras, setCameras] = useState<Device[]>([]);
  const [microphones, setMicrophones] = useState<Device[]>([]);
  const [camera, setCamera] = useState<string | null>(null);
  const [microphone, setMicrophone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!call) return;
    let current = true;
    void (async () => {
      try {
        const foundCameras = await call.cameras();
        const foundMicrophones = await call.microphones();
        if (!current) return;
        setCameras(foundCameras);
        setMicrophones(foundMicrophones);
        if (foundMicrophones[0]) {
          await call.setMicrophone(foundMicrophones[0].id);
          if (current) setMicrophone(foundMicrophones[0].id);
        }
        if (foundCameras[0]) {
          await call.setCamera(foundCameras[0].id);
          if (current) setCamera(foundCameras[0].id);
        }
      } catch (caught) {
        if (current) setProblem(deviceProblem(caught));
      }
    })();
    return () => {
      current = false;
    };
  }, [call]);

  const chooseCamera = async (deviceId: string | null) => {
    try {
      await call?.setCamera(deviceId);
      setCamera(deviceId);
      setProblem(null);
    } catch (caught) {
      setProblem(deviceProblem(caught));
    }
  };
  const chooseMicrophone = async (deviceId: string) => {
    try {
      await call?.setMicrophone(deviceId);
      setMicrophone(deviceId);
      setProblem(null);
    } catch (caught) {
      setProblem(deviceProblem(caught));
    }
  };
  return { cameras, microphones, camera, microphone, problem, chooseCamera, chooseMicrophone };
}
