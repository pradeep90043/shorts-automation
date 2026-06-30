#!/bin/bash
# Run this on a fresh Oracle Cloud Ubuntu or Oracle Linux VM
set -e

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS=$(uname -s)
fi

echo "==> Detected OS: $OS"

if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
    echo "==> Installing Docker on Ubuntu/Debian..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
    
    echo "==> Configuring firewall (iptables)..."
    sudo iptables -I INPUT 6 -p tcp --dport 3000 -j ACCEPT || true
    sudo iptables -I INPUT 6 -p tcp --dport 3001 -j ACCEPT || true
    sudo netfilter-persistent save || true
    
elif [ "$OS" = "ol" ] || [ "$OS" = "rhel" ] || [ "$OS" = "centos" ] || [ "$OS" = "rocky" ] || [ "$OS" = "almalinux" ]; then
    echo "==> Installing Docker on RedHat/Oracle Linux..."
    sudo dnf install -y yum-utils
    sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    
    echo "==> Starting and enabling Docker service..."
    sudo systemctl start docker
    sudo systemctl enable docker
    sudo usermod -aG docker $USER
    
    echo "==> Configuring VM firewall (firewalld & iptables)..."
    sudo firewall-cmd --zone=public --add-port=3000/tcp --permanent || true
    sudo firewall-cmd --zone=public --add-port=3001/tcp --permanent || true
    sudo firewall-cmd --reload || true
    
    sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT || true
    sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT || true
else
    echo "❌ Unsupported OS: $OS. Please install Docker manually."
    exit 1
fi

echo ""
echo "✅ VM Setup Complete."
echo ""
echo "Next steps on your local machine:"
echo "  1. Upload your project folder to the VM:"
echo "     scp -i ~/Downloads/oracle_key -r . opc@<VM_IP>:~/shorts-automation"
echo ""
echo "Next steps on the VM (SSH into VM first: ssh -i ~/Downloads/oracle_key opc@<VM_IP>):"
echo "  2. cd ~/shorts-automation"
echo "  3. Start the application:"
echo "     docker compose up --build -d"
echo "  4. Watch logs to verify everything runs correctly:"
echo "     docker compose logs -f"
