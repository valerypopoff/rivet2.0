export default function worker(value) {
  return { doubled: value * 2, environment: process.env.RIVET_WORKER_SECURITY_FIXTURE };
}
