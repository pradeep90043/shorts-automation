#!/bin/bash
# Run this on a fresh Oracle Cloud Ubuntu 22.04 VM
set -e

echo "==> Installing Docker..."
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

echo "==> Installing Docker Compose plugin..."
sudo apt-get install -y docker-compose-plugin

echo "==> Pulling project from GitHub (edit URL below)..."
# git clone https://github.com/YOUR_USERNAME/shorts-automation.git
# cd shorts-automation

echo ""
echo "✅ Docker ready."
echo ""
echo "Next steps on the VM:"
echo "  1. Upload your project:  scp -r . ubuntu@<VM_IP>:~/shorts-automation"
echo "  2. SSH in:               ssh ubuntu@<VM_IP>"
echo "  3. cd ~/shorts-automation"
echo "  4. docker compose up --build -d"
echo "  5. Watch logs:           docker compose logs -f"
