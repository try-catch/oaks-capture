import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('setup_ssh', Path(__file__).with_name('setup-ssh.py'))
setup_ssh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup_ssh)


class SetupSshTests(unittest.TestCase):
    def test_transient_connection_failure_is_retried(self):
        command = ['ssh', 'oaks-store']
        with patch.object(setup_ssh.subprocess, 'run', side_effect=[Mock(returncode=255), Mock(returncode=0)]) as run, patch.object(setup_ssh.time, 'sleep') as sleep:
            setup_ssh.connect(command)
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_last_connection_failure_is_reported(self):
        command = ['ssh', 'oaks-store']
        with patch.object(setup_ssh.subprocess, 'run', return_value=Mock(returncode=255)), patch.object(setup_ssh.time, 'sleep'):
            with self.assertRaises(subprocess.CalledProcessError):
                setup_ssh.connect(command, attempts=2)


if __name__ == '__main__':
    unittest.main()
