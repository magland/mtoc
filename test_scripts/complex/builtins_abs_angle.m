% abs / angle / sign on scalar complex.
% abs always returns a real scalar; angle always returns a real scalar
% (in [-pi, pi] for complex; 0/pi for real); sign propagates complexity.
disp(abs(3 + 4i));
disp(abs(1 + 2i));
disp(abs(-5));
disp(abs(0));

disp(angle(1 + 1i));
disp(angle(1i));
disp(angle(-1 + 0i));
disp(angle(1));
disp(angle(-2));
disp(angle(0));

% sign on real and complex
disp(sign(3));
disp(sign(-3));
disp(sign(0));
disp(sign(3 + 4i));
disp(sign(1 + 1i));
