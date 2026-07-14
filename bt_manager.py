import subprocess
import time

class BluetoothManager:
    def run_command(self, command):
        """Menjalankan perintah terminal dan mengambil outputnya"""
        try:
            result = subprocess.check_output(command, shell=True, stderr=subprocess.STDOUT)
            return result.decode('utf-8')
        except subprocess.CalledProcessError as e:
            return e.output.decode('utf-8')

    def parse_devices(self, raw_output):
        devices = []
        for line in raw_output.split('\n'):
            if "Device" in line:
                try:
                    parts = line.split(' ', 2)
                    if len(parts) >= 3:
                        devices.append({'mac': parts[1], 'name': parts[2].strip()})
                except: continue
        return devices

    def get_paired_devices(self):
        raw_output = self.run_command("bluetoothctl devices Paired")
        return self.parse_devices(raw_output)

    def scan_devices(self):
        """
        Scan Pintar: Hapus cache sampah dulu, baru scan fresh.
        """
        print("--- MULAI PROSES SCAN BERSIH ---")
        
        # 1. AMBIL DATA LAMA
        paired = self.get_paired_devices()
        paired_macs = [d['mac'] for d in paired]
        
        all_devs_raw = self.run_command("bluetoothctl devices")
        all_devs = self.parse_devices(all_devs_raw)
        
        # 2. HAPUS CACHE (Hapus device yang TIDAK dipairing)
        for dev in all_devs:
            if dev['mac'] not in paired_macs:
                self.run_command(f"bluetoothctl remove {dev['mac']}")
        
        # 3. SCANNING AKTIF (5 Detik)
        try:
            scan_proc = subprocess.Popen(
                ["bluetoothctl", "scan", "on"], 
                stdout=subprocess.DEVNULL, 
                stderr=subprocess.DEVNULL
            )
            time.sleep(5)
            scan_proc.terminate()
            try:
                scan_proc.wait(timeout=1)
            except:
                scan_proc.kill()
        except Exception as e:
            print(f"Error Scan: {e}")
        
        # 4. AMBIL HASIL FRESH
        fresh_raw = self.run_command("bluetoothctl devices")
        fresh_list = self.parse_devices(fresh_raw)
        
        # 5. FILTER HASIL (Hanya tampilkan yang BELUM dipairing)
        available_devices = []
        for dev in fresh_list:
            if dev['mac'] not in paired_macs:
                available_devices.append(dev)
                
        return available_devices

    def connect_device(self, mac_address):
        print(f"Connecting to {mac_address}...")
        self.run_command(f"bluetoothctl trust {mac_address}")
        self.run_command(f"bluetoothctl pair {mac_address}")
        result = self.run_command(f"bluetoothctl connect {mac_address}")
        
        if "Connection successful" in result:
            return True, "Berhasil terhubung!"
        elif "Failed to connect" in result:
             return False, "Gagal. Pastikan alat nyala & dekat."
        else:
            return True, "Perintah dikirim."

    def disconnect_device(self, mac_address):
        self.run_command(f"bluetoothctl disconnect {mac_address}")
        return True
