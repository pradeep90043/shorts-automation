#!/usr/bin/env python3
"""
Oracle Cloud Ampere A1 (ARM) Always-Free Instance Sniper
--------------------------------------------------------
Continuously attempts to provision an Always-Free Ampere A1 instance in
availability domains where capacity is intermittently full (e.g. Mumbai ap-mumbai-1).

Once capacity frees up, it claims the instance, waits for the public IP,
and sends a Telegram alert with the connection details.
"""

import os
import sys
import time
import requests
from datetime import datetime

try:
    import oci
except ImportError:
    print("❌ Error: 'oci' Python SDK is not installed. Run: pip install oci")
    sys.exit(1)

# ── Configuration ─────────────────────────────────────────────────────────────
CONFIG_FILE = os.path.expanduser("~/.oci/config")
PROFILE = "DEFAULT"

OCPUS = float(os.getenv("ARM_OCPUS", "2"))
MEMORY_IN_GBS = float(os.getenv("ARM_RAM_GB", "12"))
BOOT_VOLUME_SIZE_GB = int(os.getenv("ARM_DISK_GB", "100"))
INSTANCE_NAME = "shorts-and-video-arm"

# Validated Ubuntu 24.04 aarch64 image in ap-mumbai-1
IMAGE_OCID = "ocid1.image.oc1.ap-mumbai-1.aaaaaaaa2jurqb3jm7hlpqw3au35loaqjkcozbyh7znn4jnfu5zbrgfulwia"
SUBNET_OCID = "ocid1.subnet.oc1.ap-mumbai-1.aaaaaaaazss5bkfln7aqktrnvo3ia3wt6vxensrjhmgpegycgtwp6zumhahq"
AD_NAME = "LoCP:AP-MUMBAI-1-AD-1"

SSH_KEY_PATH = os.path.expanduser("~/Downloads/oracle_key.pub")
TELEGRAM_BOT_TOKEN = "8947411485:AAG0cqcP43Q2qdaHxtXsYrUVgMMrS17HdQI"
TELEGRAM_CHAT_ID = "7668650862"

RETRY_INTERVAL_SECONDS = 60


def send_telegram_alert(message: str):
    """Sends a notification to the admin Telegram chat."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "Markdown"}
        requests.post(url, json=payload, timeout=10)
    except Exception as e:
        print(f"⚠️ Failed to send Telegram alert: {e}")


def main():
    if not os.path.exists(CONFIG_FILE):
        print(f"❌ OCI configuration file not found at {CONFIG_FILE}.")
        sys.exit(1)

    print("🚀 Initializing OCI Client from", CONFIG_FILE)
    config = oci.config.from_file(CONFIG_FILE, PROFILE)
    
    compute_client = oci.core.ComputeClient(config)
    vnet_client = oci.core.VirtualNetworkClient(config)

    compartment_id = config.get("tenancy")
    print(f"📌 Tenancy / Compartment: {compartment_id}")
    print(f"📍 Target Availability Domain: {AD_NAME}")
    print(f"🌐 Target Subnet: {SUBNET_OCID}")
    print(f"📦 Target Image: Canonical-Ubuntu-24.04-aarch64 ({IMAGE_OCID})")

    # Load SSH Key
    if not os.path.exists(SSH_KEY_PATH):
        print(f"❌ SSH public key not found at {SSH_KEY_PATH}")
        sys.exit(1)
    with open(SSH_KEY_PATH, "r") as f:
        ssh_public_key = f.read().strip()

    # Build Launch Details
    shape = "VM.Standard.A1.Flex"
    shape_config = oci.core.models.LaunchInstanceShapeConfigDetails(
        ocpus=OCPUS,
        memory_in_gbs=MEMORY_IN_GBS
    )
    
    source_details = oci.core.models.InstanceSourceViaImageDetails(
        image_id=IMAGE_OCID,
        boot_volume_size_in_gbs=BOOT_VOLUME_SIZE_GB
    )

    create_vnic_details = oci.core.models.CreateVnicDetails(
        subnet_id=SUBNET_OCID,
        assign_public_ip=True,
        display_name=f"{INSTANCE_NAME}-vnic"
    )

    launch_details = oci.core.models.LaunchInstanceDetails(
        display_name=INSTANCE_NAME,
        compartment_id=compartment_id,
        availability_domain=AD_NAME,
        shape=shape,
        shape_config=shape_config,
        source_details=source_details,
        create_vnic_details=create_vnic_details,
        metadata={"ssh_authorized_keys": ssh_public_key}
    )

    print("\n" + "="*65)
    print(f"🎯 SNIPER ACTIVE: Polling Oracle for Ampere A1 ({OCPUS} OCPU / {MEMORY_IN_GBS}GB RAM)")
    print(f"⏱️ Check interval: {RETRY_INTERVAL_SECONDS}s | Telegram alerts: ENABLED")
    print("="*65 + "\n")

    attempt = 0
    while True:
        attempt += 1
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            print(f"[{now}] Attempt #{attempt}: Requesting VM.Standard.A1.Flex in AD-1...", end=" ", flush=True)
            res = compute_client.launch_instance(launch_details)
            instance = res.data
            instance_id = instance.id
            print(f"\n🎉 SUCCESS! Instance claimed: {instance.display_name} ({instance_id})")

            # Alert user via Telegram
            send_telegram_alert(
                f"🎉 *Oracle Ampere A1 Instance Claimed!*\n\n"
                f"• *Instance*: `{instance.display_name}`\n"
                f"• *Shape*: Ampere A1 ({OCPUS} OCPU / {MEMORY_IN_GBS}GB RAM / {BOOT_VOLUME_SIZE_GB}GB Disk)\n"
                f"• *Status*: Booting up...\n\n"
                f"Waiting for Public IP..."
            )

            # Wait for instance to become RUNNING and retrieve public IP
            print("⏳ Waiting for instance to transition to RUNNING state...")
            oci.wait_until(
                compute_client,
                compute_client.get_instance(instance_id),
                'lifecycle_state',
                'RUNNING',
                max_wait_seconds=600
            )

            # Get VNIC to find public IP
            vnics = compute_client.list_vnic_attachments(compartment_id=compartment_id, instance_id=instance_id).data
            public_ip = "Unknown"
            if vnics:
                vnic = vnet_client.get_vnic(vnics[0].vnic_id).data
                public_ip = vnic.public_ip

            print(f"\n✅ Instance is LIVE! Public IP: {public_ip}")
            print(f"👉 Connect: ssh -i ~/Downloads/oracle_key ubuntu@{public_ip}")

            send_telegram_alert(
                f"✅ *Oracle Ampere A1 Server is LIVE!*\n\n"
                f"• *Public IP*: `{public_ip}`\n"
                f"• *SSH Login*: `ssh -i ~/Downloads/oracle_key ubuntu@{public_ip}`\n\n"
                f"Your permanent Always-Free high-spec server is ready to deploy!"
            )
            break

        except oci.exceptions.ServiceError as e:
            if e.status == 500 or "capacity" in str(e).lower() or "outofhostcapacity" in str(e).lower():
                print(f"Out of capacity. Retrying in {RETRY_INTERVAL_SECONDS}s...")
            elif e.status == 429 or "too many requests" in str(e).lower():
                print("Rate limited (429). Backing off 90s...")
                time.sleep(90)
                continue
            elif e.status == 401 or "notauthenticated" in str(e).lower():
                print("IAM auth cache syncing. Retrying in 10s...")
                time.sleep(10)
                continue
            else:
                print(f"OCI Error ({e.status} - {e.code}): {e.message}")
        except Exception as e:
            print(f"Unexpected error: {e}")

        time.sleep(RETRY_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
